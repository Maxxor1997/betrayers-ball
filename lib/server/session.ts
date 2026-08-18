import { randomUUID } from "node:crypto";
import { chooseAiActionForDifficulty } from "@/lib/ai/difficulty";
import { AI_NAMES, MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { Rng } from "@/lib/engine/deck";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { redactedStateFor } from "@/lib/engine/playerView";
import { currentPlayerId } from "@/lib/engine/turns";
import { AiDifficulty, CenterEffectId, GameAction, GameState } from "@/lib/engine/types";
import { computeRanks, placementBaseline, placementMaxDeviation } from "@/lib/playtest/cardStats";
import { DISPLAY_VIEWER_ID, LobbyState, RoomStatsEntry, RoomSummary, SeatInfo, toWireState, WireGameState } from "./protocol";

/** Same pacing as the single-player AI turn effect in app/play/page.tsx, so a mixed human/AI room feels consistent regardless of mode. */
const AI_TURN_DELAY_MS = 550;

/** How long an unstarted lobby can sit with nobody touching it before RoomRegistry reaps it. */
export const UNSTARTED_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** How long a finished game can sit un-rematched and un-closed before RoomRegistry reaps it -- longer than the unstarted timeout since a finished table of players is more likely to just be chatting/deciding on a rematch than an abandoned lobby is. */
export const ENDED_IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

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
  /** DISPLAY_VIEWER_ID when displayHosted -- the host has no seat, so this is a pseudo-playerId, not a key into `seats`. */
  readonly hostPlayerId: string;
  private readonly displayHosted: boolean;
  /** Stored separately from `seats` -- getSummary() needs it even when displayHosted leaves no host seat to read it from. */
  private readonly hostNameLabel: string;
  private readonly hostTokenValue: string;
  /** Undefined means no password -- the room:join-gating check is skipped entirely, matching the room's pre-password behavior. Never sent back to any client (see getSummary()'s hasPassword instead). */
  private readonly roomPassword?: string;
  private readonly playerCount: number;
  /** Not readonly -- rematch() can change the location for the next deal, unlike playerCount which is fixed to the room's existing seats. */
  private centerEffect: CenterEffectId;
  /** Not readonly -- rematch() can change it too, same as centerEffect. */
  private aiDifficulty: AiDifficulty;
  private readonly serverOrigin: string;
  private readonly rng?: Rng;
  private readonly seats = new Map<string, Seat>();
  private state: GameState | null = null;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSeatIndex = 0;
  /**
   * Cumulative per-seat record across every game this room has played -- see
   * RoomStatsEntry. Lives here (not on GameState) specifically so rematch()'s fresh
   * GameState doesn't wipe it: this is a room-level running total, not a single game's
   * result. Never reset by rematch, only implicitly by the room itself going away.
   */
  private readonly roomStats = new Map<string, { games: number; wins: number; placementDeltaSum: number }>();
  /** Last time anyone actually did something in this room -- see touch()/isReapable(). Starts at creation time, since a freshly-created lobby is itself a form of activity. */
  private lastActivityAt = Date.now();

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
    rng?: Rng,
    /** Jackbox-style shared screen -- the host takes no seat, and all `playerCount` seats are open for real players/AI. Defaults false so every existing single-device-host call site is unaffected. */
    displayHosted = false,
    /** Trailing optional, defaulting to "medium" -- so every existing call site (including tests) that predates AI difficulty keeps working unchanged. */
    aiDifficulty: AiDifficulty = "medium",
    /** Trailing optional -- blank/undefined means no password, same as every call site that predates this feature. Trimmed here (not by the caller) so " " isn't treated as a real password. */
    password?: string
  ) {
    if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
      throw new Error(`playerCount must be an integer between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }
    this.roomCode = roomCode;
    this.playerCount = playerCount;
    this.centerEffect = centerEffect;
    this.aiDifficulty = aiDifficulty;
    this.serverOrigin = serverOrigin;
    this.rng = rng;
    this.displayHosted = displayHosted;
    // Uppercased at construction (not just compared case-insensitively) so the value
    // handed back to the host for display (see the `password` getter/CreateRoomResult)
    // always matches what a joiner has to type -- same "all caps, no ambiguity about
    // case" treatment as room codes themselves.
    this.roomPassword = password?.trim().toUpperCase() || undefined;
    this.hostNameLabel = hostName;
    this.onLobbyChange = handlers.onLobbyChange;
    this.onPlayerState = handlers.onPlayerState;

    if (displayHosted) {
      this.hostPlayerId = DISPLAY_VIEWER_ID;
      this.hostTokenValue = randomUUID();
    } else {
      const host = this.newSeat(hostName, false);
      this.hostPlayerId = host.playerId;
      this.seats.set(host.playerId, host);
      this.hostTokenValue = host.token!;
    }
  }

  private newSeat(name: string, isAI: boolean): Seat {
    const playerId = isAI ? `ai-${this.nextSeatIndex}` : `p${this.nextSeatIndex}`;
    this.nextSeatIndex++;
    return { playerId, name, isAI, connected: true, token: isAI ? undefined : randomUUID() };
  }

  get started(): boolean {
    return this.state !== null;
  }

  /** Undefined if the room has no password. Only meant to be handed back to the room's own creator (see room:create's ack) -- everyone else only ever learns hasPassword (getSummary/getLobbyState), never the value itself. */
  get password(): string | undefined {
    return this.roomPassword;
  }

  /** The host's own bearer token -- for a non-display room this is the same token its seat holds; for a display room it's a standalone token no seat ever carries. Either way, this is the only way to retrieve it, both for tests and for the real room:create handler to hand back to its caller. */
  get hostToken(): string {
    return this.hostTokenValue;
  }

  /** Trimmed-down public summary for the home screen's "active sessions" list -- see RoomSummary's doc comment for what's deliberately left out. */
  getSummary(): RoomSummary {
    return {
      roomCode: this.roomCode,
      hostName: this.hostNameLabel,
      hostIsDisplay: this.displayHosted,
      seatedCount: [...this.seats.values()].filter((s) => !s.isAI).length,
      playerCount: this.playerCount,
      centerEffect: this.centerEffect,
      started: this.started,
      hasPassword: this.roomPassword !== undefined,
    };
  }

  getLobbyState(): LobbyState {
    return {
      roomCode: this.roomCode,
      hostPlayerId: this.hostPlayerId,
      hostIsDisplay: this.displayHosted,
      playerCount: this.playerCount,
      centerEffect: this.centerEffect,
      seats: [...this.seats.values()].map(({ playerId, name, isAI, connected }) => ({ playerId, name, isAI, connected })),
      started: this.started,
      serverOrigin: this.serverOrigin,
      roomStats: [...this.roomStats.entries()].map(([playerId, s]): RoomStatsEntry => ({ playerId, ...s })),
    };
  }

  /**
   * Result carries a token the client must present on every future action/rejoin --
   * treat it like a bearer credential, never broadcast. `password` is only checked
   * here (joining) -- once seated, room:rejoin authenticates by that token alone, so a
   * password change (there is none, currently -- it's fixed at room creation) or a
   * forgotten password never locks an already-seated player out.
   */
  addPlayer(name: string, password?: string): { playerId: string; token: string } | { error: string } {
    if (this.started) return { error: "This game has already started." };
    if (this.roomPassword !== undefined && password?.trim().toUpperCase() !== this.roomPassword) return { error: "Incorrect room password." };
    const humanSeats = [...this.seats.values()].filter((s) => !s.isAI);
    if (humanSeats.length >= this.playerCount) return { error: "This room is full." };

    const seat = this.newSeat(name, false);
    this.seats.set(seat.playerId, seat);
    this.touch();
    this.onLobbyChange(this.getLobbyState());
    return { playerId: seat.playerId, token: seat.token! };
  }

  /** Re-attaches a fresh connection (e.g. a page refresh) to an already-claimed seat -- or, for a display-hosted room, back to the host's seatless pseudo-identity. */
  rejoin(token: string): { playerId: string } | { error: string } {
    if (this.displayHosted && token === this.hostTokenValue) {
      this.touch();
      this.onLobbyChange(this.getLobbyState());
      if (this.state) this.pushStateTo(DISPLAY_VIEWER_ID);
      return { playerId: DISPLAY_VIEWER_ID };
    }
    const seat = [...this.seats.values()].find((s) => s.token === token);
    if (!seat) return { error: "That session isn't valid for this room anymore." };
    seat.connected = true;
    this.touch();
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
    return token === this.hostTokenValue;
  }

  /** Host-only. Fills any seats still open at `playerCount` with AI, then deals and starts the real game. */
  start(callerToken: string): { ok: true } | { error: string } {
    if (!this.isHost(callerToken)) return { error: "Only the host can start the game." };
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
   * as room:create. `aiDifficulty` can change too, same reasoning.
   */
  rematch(callerToken: string, centerEffect: CenterEffectId, aiDifficulty: AiDifficulty): { ok: true } | { error: string } {
    if (!this.isHost(callerToken)) return { error: "Only the host can start a new game." };
    if (!this.state || this.state.phase !== "ended") return { error: "The current game hasn't ended yet." };

    this.centerEffect = centerEffect;
    this.aiDifficulty = aiDifficulty;
    this.dealAndStart();
    this.onLobbyChange(this.getLobbyState());
    return { ok: true };
  }

  /** Shared by start() and rematch() -- deals a fresh GameState to the current seat lineup and kicks off play. */
  private dealAndStart(): void {
    const allIds = [...this.seats.keys()];
    const aiIds = [...this.seats.values()].filter((s) => s.isAI).map((s) => s.playerId);
    const config = configForPlayerCount(this.playerCount, this.centerEffect, this.aiDifficulty);
    const rand = this.rng ?? Math.random;
    const firstPlayerIndex = Math.floor(rand() * allIds.length);
    this.setState(createGame(allIds, config, this.rng, aiIds, firstPlayerIndex));
    this.scheduleAiTurnIfNeeded();
  }

  /**
   * Every place `this.state` gets replaced with a new GameState routes through here --
   * catches the exact moment a game's phase flips to "ended" (never mid-game, never
   * more than once per game) to fold its result into roomStats before pushing the new
   * state out to every client.
   */
  private setState(newState: GameState): void {
    const wasEnded = this.state?.phase === "ended";
    this.state = newState;
    this.touch();
    if (!wasEnded && newState.phase === "ended") this.tallyRoomStats(newState);
    this.pushStateToAll();
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * True once this room has sat idle long enough for RoomRegistry's periodic sweep to
   * close it out -- see UNSTARTED_IDLE_TIMEOUT_MS/ENDED_IDLE_TIMEOUT_MS. Deliberately
   * narrow: an unstarted lobby times out (nobody ever hit Start), and a finished game
   * left un-rematched/un-closed times out (longer window -- more likely still being
   * looked at than an abandoned lobby is), but a game that's actually still
   * `"playing"` never auto-closes here no matter how long it's been idle -- that's a
   * live, in-progress table, not an abandoned one, and disconnected players can still
   * rejoin it.
   */
  isReapable(now: number = Date.now()): boolean {
    const idleMs = now - this.lastActivityAt;
    if (!this.started) return idleMs >= UNSTARTED_IDLE_TIMEOUT_MS;
    if (this.state?.phase === "ended") return idleMs >= ENDED_IDLE_TIMEOUT_MS;
    return false;
  }

  /**
   * Folds one just-finished game's result into every seat's cumulative roomStats
   * record (see RoomStatsEntry) -- both human and AI seats, since "who's actually
   * winning this room" includes the AI opponents too. Same rank/placement-delta math
   * as lib/playtest/humanStats.ts's tallyPlacementBucket, just per-seat instead of
   * per-human and fed by the room's one fixed playerCount instead of a per-game one.
   * Broadcasts the updated lobby afterward -- roomStats changed even though no seat
   * joined/left, so clients watching a room-stats panel see it update live.
   */
  private tallyRoomStats(state: GameState): void {
    if (!state.result) return;
    const ranks = computeRanks(state.result.scores);
    for (const player of state.players) {
      const bucket = this.roomStats.get(player.id) ?? { games: 0, wins: 0, placementDeltaSum: 0 };
      const rank = ranks.get(player.id)!;
      bucket.games += 1;
      if (rank === 1) bucket.wins += 1;
      bucket.placementDeltaSum += (rank - placementBaseline(this.playerCount)) / placementMaxDeviation(this.playerCount);
      this.roomStats.set(player.id, bucket);
    }
    this.onLobbyChange(this.getLobbyState());
  }

  dispatch(callerToken: string, action: GameAction): { ok: true } | { error: string } {
    const caller = this.requireSeatByToken(callerToken);
    if ("error" in caller) return caller;
    if (!this.state) return { error: "This game hasn't started yet." };
    if (action.playerId !== caller.playerId) return { error: "You can't act on another player's behalf." };

    let next: GameState;
    try {
      next = applyAction(this.state, action, this.rng);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Illegal action." };
    }

    this.setState(next);
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
    // The display host has no seat to loop over above -- stateFor(DISPLAY_VIEWER_ID)
    // still resolves correctly since redactedStateFor treats any id that matches no
    // real player (this one by construction) as a full spectator: every hand and
    // face-down card comes back hidden, exactly the "nobody's" view a shared screen
    // needs.
    if (this.displayHosted) this.pushStateTo(DISPLAY_VIEWER_ID);
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
      const action = chooseAiActionForDifficulty(this.state, activeId, this.state.config.aiDifficulty, this.rng);
      this.setState(applyAction(this.state, action, this.rng));
      this.scheduleAiTurnIfNeeded();
    }, AI_TURN_DELAY_MS);
  }

  /** Cancels any pending AI-turn timer -- call when a room is torn down so it doesn't keep the process alive or fire against a discarded session. */
  dispose(): void {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.aiTimer = null;
  }
}
