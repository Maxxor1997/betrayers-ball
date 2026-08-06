import { randomUUID } from "node:crypto";
import { chooseGreedyAiAction } from "@/lib/ai/greedyAi";
import { AI_NAMES, MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { Rng } from "@/lib/engine/deck";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { redactedStateFor } from "@/lib/engine/playerView";
import { currentPlayerId } from "@/lib/engine/turns";
import { CenterEffectId, GameAction, GameState } from "@/lib/engine/types";
import { LobbyState, RoomSummary, SeatInfo, toWireState, WireGameState } from "./protocol";

/** Same pacing as the single-player AI turn effect in app/play/page.tsx, so a mixed human/AI room feels consistent regardless of mode. */
const AI_TURN_DELAY_MS = 550;

interface Seat extends SeatInfo {
  /** Undefined for AI seats -- never dealt a token since nothing ever authenticates as them. */
  token?: string;
}

/**
 * One hosted game: lobby (pre-start) through a finished game. Holds the true,
 * unredacted GameState -- callers only ever get a per-viewer redacted copy via
 * `stateFor`. Decoupled from Socket.IO entirely (the `onLobbyChange`/`onPlayerState`
 * callbacks are the only way this class talks to the outside world) so it's testable
 * without a real server -- see lib/server/__tests__/session.test.ts.
 */
export class GameSession {
  readonly roomCode: string;
  readonly hostPlayerId: string;
  private readonly playerCount: number;
  /** Not readonly -- rematch() can change the location for the next deal, unlike playerCount which is fixed to the room's existing seats. */
  private centerEffect: CenterEffectId;
  private readonly serverOrigin: string;
  private readonly rng?: Rng;
  private readonly seats = new Map<string, Seat>();
  private state: GameState | null = null;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSeatIndex = 0;

  private onLobbyChange: (lobby: LobbyState) => void;
  private onPlayerState: (playerId: string, state: WireGameState) => void;

  constructor(
    roomCode: string,
    hostName: string,
    playerCount: number,
    centerEffect: CenterEffectId,
    serverOrigin: string,
    handlers: {
      onLobbyChange: (lobby: LobbyState) => void;
      onPlayerState: (playerId: string, state: WireGameState) => void;
    },
    rng?: Rng
  ) {
    if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
      throw new Error(`playerCount must be an integer between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }
    this.roomCode = roomCode;
    this.playerCount = playerCount;
    this.centerEffect = centerEffect;
    this.serverOrigin = serverOrigin;
    this.rng = rng;
    this.onLobbyChange = handlers.onLobbyChange;
    this.onPlayerState = handlers.onPlayerState;

    const host = this.newSeat(hostName, false);
    this.hostPlayerId = host.playerId;
    this.seats.set(host.playerId, host);
  }

  private newSeat(name: string, isAI: boolean): Seat {
    const playerId = isAI ? `ai-${this.nextSeatIndex}` : `p${this.nextSeatIndex}`;
    this.nextSeatIndex++;
    return { playerId, name, isAI, connected: true, token: isAI ? undefined : randomUUID() };
  }

  get started(): boolean {
    return this.state !== null;
  }

  /** The host's own bearer token -- seated directly in the constructor (not via addPlayer), so this is the only way to retrieve it, both for tests and for the real room:create handler to hand back to its caller. */
  get hostToken(): string {
    return this.seats.get(this.hostPlayerId)!.token!;
  }

  /** Trimmed-down public summary for the home screen's "active sessions" list -- see RoomSummary's doc comment for what's deliberately left out. */
  getSummary(): RoomSummary {
    return {
      roomCode: this.roomCode,
      hostName: this.seats.get(this.hostPlayerId)!.name,
      seatedCount: [...this.seats.values()].filter((s) => !s.isAI).length,
      playerCount: this.playerCount,
      centerEffect: this.centerEffect,
      started: this.started,
    };
  }

  getLobbyState(): LobbyState {
    return {
      roomCode: this.roomCode,
      hostPlayerId: this.hostPlayerId,
      playerCount: this.playerCount,
      centerEffect: this.centerEffect,
      seats: [...this.seats.values()].map(({ playerId, name, isAI, connected }) => ({ playerId, name, isAI, connected })),
      started: this.started,
      serverOrigin: this.serverOrigin,
    };
  }

  /** Result carries a token the client must present on every future action/rejoin -- treat it like a bearer credential, never broadcast. */
  addPlayer(name: string): { playerId: string; token: string } | { error: string } {
    if (this.started) return { error: "This game has already started." };
    const humanSeats = [...this.seats.values()].filter((s) => !s.isAI);
    if (humanSeats.length >= this.playerCount) return { error: "This room is full." };

    const seat = this.newSeat(name, false);
    this.seats.set(seat.playerId, seat);
    this.onLobbyChange(this.getLobbyState());
    return { playerId: seat.playerId, token: seat.token! };
  }

  /** Re-attaches a fresh connection (e.g. a page refresh) to an already-claimed seat. */
  rejoin(token: string): { playerId: string } | { error: string } {
    const seat = [...this.seats.values()].find((s) => s.token === token);
    if (!seat) return { error: "That session isn't valid for this room anymore." };
    seat.connected = true;
    this.onLobbyChange(this.getLobbyState());
    if (this.state) this.pushStateTo(seat.playerId);
    return { playerId: seat.playerId };
  }

  markDisconnected(playerId: string): void {
    const seat = this.seats.get(playerId);
    if (!seat || seat.isAI) return;
    seat.connected = false;
    this.onLobbyChange(this.getLobbyState());
  }

  private requireSeatByToken(token: string): Seat | { error: string } {
    const seat = [...this.seats.values()].find((s) => s.token === token);
    if (!seat) return { error: "Not a recognized player in this room." };
    return seat;
  }

  /**
   * True if `token` belongs to this room's host. Used by the host-only "end room"
   * action -- unlike start/rematch/dispatch, actually deleting a room is a
   * registry-level operation (this class has no registry access to remove itself
   * from), so wireSocketServer.ts calls this to authorize before it does that.
   */
  isHost(token: string): boolean {
    const caller = this.requireSeatByToken(token);
    return "error" in caller ? false : caller.playerId === this.hostPlayerId;
  }

  /** Host-only. Fills any seats still open at `playerCount` with AI, then deals and starts the real game. */
  start(callerToken: string): { ok: true } | { error: string } {
    const caller = this.requireSeatByToken(callerToken);
    if ("error" in caller) return caller;
    if (caller.playerId !== this.hostPlayerId) return { error: "Only the host can start the game." };
    if (this.started) return { error: "This game has already started." };

    let aiIndex = 0;
    while (this.seats.size < this.playerCount) {
      const seat = this.newSeat(AI_NAMES[aiIndex % AI_NAMES.length], true);
      this.seats.set(seat.playerId, seat);
      aiIndex++;
    }

    this.dealAndStart();
    this.onLobbyChange(this.getLobbyState());
    return { ok: true };
  }

  /**
   * Host-only. Deals a fresh game to the exact same seats (same humans, same AI slots
   * filled at the original Start) without touching the room itself -- the same join
   * link/lobby keeps working, nobody has to reconnect. Only allowed once the previous
   * game has actually ended; there's no sensible "rematch" mid-game. `centerEffect` can
   * change the location for this next game (unlike player count, which is fixed to the
   * seats already at the table) -- already resolved from "random" by the caller, same
   * as room:create.
   */
  rematch(callerToken: string, centerEffect: CenterEffectId): { ok: true } | { error: string } {
    const caller = this.requireSeatByToken(callerToken);
    if ("error" in caller) return caller;
    if (caller.playerId !== this.hostPlayerId) return { error: "Only the host can start a new game." };
    if (!this.state || this.state.phase !== "ended") return { error: "The current game hasn't ended yet." };

    this.centerEffect = centerEffect;
    this.dealAndStart();
    this.onLobbyChange(this.getLobbyState());
    return { ok: true };
  }

  /** Shared by start() and rematch() -- deals a fresh GameState to the current seat lineup and kicks off play. */
  private dealAndStart(): void {
    const allIds = [...this.seats.keys()];
    const aiIds = [...this.seats.values()].filter((s) => s.isAI).map((s) => s.playerId);
    const config = configForPlayerCount(this.playerCount, this.centerEffect);
    const rand = this.rng ?? Math.random;
    const firstPlayerIndex = Math.floor(rand() * allIds.length);
    this.state = createGame(allIds, config, this.rng, aiIds, firstPlayerIndex);

    this.pushStateToAll();
    this.scheduleAiTurnIfNeeded();
  }

  dispatch(callerToken: string, action: GameAction): { ok: true } | { error: string } {
    const caller = this.requireSeatByToken(callerToken);
    if ("error" in caller) return caller;
    if (!this.state) return { error: "This game hasn't started yet." };
    if (action.playerId !== caller.playerId) return { error: "You can't act on another player's behalf." };

    try {
      this.state = applyAction(this.state, action, this.rng);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Illegal action." };
    }

    this.pushStateToAll();
    this.scheduleAiTurnIfNeeded();
    return { ok: true };
  }

  /** Redacted, wire-safe view of the game for one specific player -- null before the game has started. */
  stateFor(playerId: string): WireGameState | null {
    if (!this.state) return null;
    return toWireState(redactedStateFor(this.state, playerId));
  }

  private pushStateTo(playerId: string): void {
    const wire = this.stateFor(playerId);
    if (wire) this.onPlayerState(playerId, wire);
  }

  private pushStateToAll(): void {
    for (const seat of this.seats.values()) this.pushStateTo(seat.playerId);
  }

  /**
   * Drives AI turns the same way the single-player client's effect does (see
   * app/play/page.tsx) -- wait a beat, compute the AI's move, apply it, push, and
   * check again (an AI turn can be up to two actions: an optional flip, then a
   * place/pass). Re-entrant-safe: only ever one timer live at a time.
   */
  private scheduleAiTurnIfNeeded(): void {
    if (this.aiTimer || !this.state || this.state.phase !== "playing") return;
    const seat = this.seats.get(currentPlayerId(this.state));
    if (!seat?.isAI) return;

    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      if (!this.state || this.state.phase !== "playing") return;
      const activeId = currentPlayerId(this.state);
      if (this.seats.get(activeId)?.isAI !== true) return;
      const action = chooseGreedyAiAction(this.state, activeId, this.rng);
      this.state = applyAction(this.state, action, this.rng);
      this.pushStateToAll();
      this.scheduleAiTurnIfNeeded();
    }, AI_TURN_DELAY_MS);
  }

  /** Cancels any pending AI-turn timer -- call when a room is torn down so it doesn't keep the process alive or fire against a discarded session. */
  dispose(): void {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.aiTimer = null;
  }
}
