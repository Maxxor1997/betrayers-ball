import { randomUUID } from "node:crypto";
import { AI_TURN_DELAY_MS, chooseAiActionForDifficulty, computeVoteForDifficulty } from "@/lib/ai/difficulty";
import { AI_NAMES, MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { Rng, shuffle } from "@/lib/engine/deck";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { redactedStateFor } from "@/lib/engine/playerView";
import { currentPlayerId } from "@/lib/engine/turns";
import { AiDifficulty, CenterEffectId, GameAction, GameState } from "@/lib/engine/types";
import { randomCenterEffectPool } from "@/lib/content/centerEffects";
import { resolveBoard } from "@/lib/engine/resolution";
import { computeRanks, createEmptyStats, placementBaseline, placementMaxDeviation, PlaytestStats, statsSummary, tallyGame } from "@/lib/playtest/cardStats";
import { DISPLAY_VIEWER_ID, LobbyState, RoomStatsEntry, RoomSummary, SeatInfo, toWireState, WireGameState } from "./protocol";
import { logEvent } from "./analytics";

/** How long an unstarted lobby can sit with nobody touching it before RoomRegistry reaps it. */
export const UNSTARTED_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** How long a finished game can sit un-rematched and un-closed before RoomRegistry reaps it -- longer than the unstarted timeout since a finished table of players is more likely to just be chatting/deciding on a rematch than an abandoned lobby is. */
export const ENDED_IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

interface Seat extends SeatInfo {
  /** Undefined for AI seats -- never dealt a token since nothing ever authenticates as them. */
  token?: string;
  /** See app/hooks/deviceId.ts. Undefined for AI seats, same as token -- nothing real connects as them. Used by addPlayer to reject a second fresh join from a device that already holds a seat here (rejoin, which reuses this same seat via its token, is unaffected). */
  deviceId?: string;
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
  /** Stored separately from `seats` -- getSummary() needs it even when displayHosted leaves no host seat to read it from. Not readonly -- renameSeat can update it for the host same as any other seat. */
  private hostNameLabel: string;
  private readonly hostTokenValue: string;
  /** Undefined means no password -- the room:join-gating check is skipped entirely, matching the room's pre-password behavior. Never sent back to any client (see getSummary()'s hasPassword instead). */
  private readonly roomPassword?: string;
  private readonly playerCount: number;
  /** Not readonly -- rematch() can change the location for the next deal, unlike playerCount which is fixed to the room's existing seats. */
  private centerEffect: CenterEffectId;
  /** See LobbyState's doc comment -- the raw, unresolved choice `centerEffect` was last set from. Not readonly -- rematch() updates it same as centerEffect. */
  private centerEffectMode: CenterEffectId | "random";
  /** Not readonly -- rematch() can change it too, same as centerEffect. */
  private aiDifficulty: AiDifficulty;
  private readonly serverOrigin: string;
  private readonly rng?: Rng;
  private readonly seats = new Map<string, Seat>();
  private state: GameState | null = null;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSeatIndex = 0;
  /**
   * Passed into every real applyAction call below -- without this, a round-boundary
   * vote auto-fill would silently use plain computeAiVote regardless of aiDifficulty
   * (see game.ts's ComputeVoteFn doc comment). An arrow-function field (not a method)
   * so `this` stays bound when passed by reference as applyAction's 4th argument.
   */
  private computeVote = (state: GameState, playerId: string, rng: Rng): boolean => computeVoteForDifficulty(state, playerId, this.aiDifficulty, rng);
  /**
   * Cumulative per-seat record across every game this room has played -- see
   * RoomStatsEntry. Lives here (not on GameState) specifically so rematch()'s fresh
   * GameState doesn't wipe it: this is a room-level running total, not a single game's
   * result. Never reset by rematch, only implicitly by the room itself going away.
   */
  private readonly roomStats = new Map<string, { games: number; wins: number; placementDeltaSum: number }>();
  /** Per-card breakdown for this room only, same shape/tallying as the bulk playtest simulator's own stats -- see RoomStatsModal's collapsed "By card" section. */
  private readonly roomCardStats: PlaytestStats = createEmptyStats();
  /**
   * Which real seated players have clicked "ready" for the next game -- screencast
   * (display-hosted) rooms only, see readyForRematch. A one-way set, never toggled
   * off by its own owner (matches "everyone needs to click and can't unclick"); reset
   * to empty every time dealAndStart actually deals a fresh game, so it's clean again
   * for the game after that. AI seats never appear here -- they can't click anything,
   * and readyForRematch only counts real seats toward "everyone."
   */
  private readonly rematchReady = new Set<string>();
  /** Last time anyone actually did something in this room -- see touch()/isReapable(). Starts at creation time, since a freshly-created lobby is itself a form of activity. */
  private lastActivityAt = Date.now();
  /** When the currently-live (or just-ended) game was dealt -- see dealAndStart()/tallyRoomStats(). Reset on every fresh deal (start/rematch), so a room's Nth game logs its own duration, not the whole room's lifetime. */
  private matchStartedAt = Date.now();

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
    password?: string,
    /** The host's own device id (see app/hooks/deviceId.ts) -- undefined for a display-hosted room (no host seat to attach it to) or any call site that predates this feature. */
    hostDeviceId?: string,
    /** The RAW, pre-resolution location choice -- see LobbyState.centerEffectMode. Trailing optional, defaulting to `centerEffect` (never actually random), same reasoning as every other trailing default here. */
    centerEffectMode: CenterEffectId | "random" = centerEffect
  ) {
    if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
      throw new Error(`playerCount must be an integer between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }
    this.roomCode = roomCode;
    this.playerCount = playerCount;
    this.centerEffect = centerEffect;
    this.centerEffectMode = centerEffectMode;
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
      const host = this.newSeat(hostName, false, hostDeviceId);
      this.hostPlayerId = host.playerId;
      this.seats.set(host.playerId, host);
      this.hostTokenValue = host.token!;
    }
  }

  private newSeat(name: string, isAI: boolean, deviceId?: string): Seat {
    const playerId = isAI ? `ai-${this.nextSeatIndex}` : `p${this.nextSeatIndex}`;
    this.nextSeatIndex++;
    return { playerId, name, isAI, connected: true, token: isAI ? undefined : randomUUID(), deviceId: isAI ? undefined : deviceId };
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
      hostPlayerId: this.hostPlayerId,
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
      centerEffectMode: this.centerEffectMode,
      seats: [...this.seats.values()].map(({ playerId, name, isAI, connected }) => ({ playerId, name, isAI, connected })),
      started: this.started,
      serverOrigin: this.serverOrigin,
      roomStats: [...this.roomStats.entries()].map(([playerId, s]): RoomStatsEntry => ({ playerId, ...s })),
      roomCardStats: statsSummary(this.roomCardStats),
      rematchReadyPlayerIds: [...this.rematchReady],
    };
  }

  /**
   * Result carries a token the client must present on every future action/rejoin --
   * treat it like a bearer credential, never broadcast. `password` is only checked
   * here (joining) -- once seated, room:rejoin authenticates by that token alone, so a
   * password change (there is none, currently -- it's fixed at room creation) or a
   * forgotten password never locks an already-seated player out.
   */
  addPlayer(name: string, password?: string, deviceId?: string): { playerId: string; token: string } | { error: string } {
    if (this.started) return { error: "This game has already started." };
    if (this.roomPassword !== undefined && password?.trim().toUpperCase() !== this.roomPassword) return { error: "Incorrect room password." };
    const humanSeats = [...this.seats.values()].filter((s) => !s.isAI);
    if (humanSeats.length >= this.playerCount) return { error: "This room is full." };
    // Fresh join only -- rejoin() re-attaches to an EXISTING seat via its token, so a
    // device reconnecting to its own seat (a real refresh/reopened tab) never hits
    // this at all. This only blocks a device trying to claim a SECOND, different seat
    // in the same room.
    if (deviceId !== undefined && humanSeats.some((s) => s.deviceId === deviceId)) {
      return { error: "This device already has a seat in this room." };
    }

    const seat = this.newSeat(name, false, deviceId);
    this.seats.set(seat.playerId, seat);
    this.touch();
    this.onLobbyChange(this.getLobbyState());
    return { playerId: seat.playerId, token: seat.token! };
  }

  /**
   * Lets a seated player (host or guest) change their own display name while still in
   * the lobby -- pre-start only, same as addPlayer itself; renaming mid-game would
   * desync every other viewer's already-rendered name history (past turns, votes,
   * end-screen rows) for no real benefit. Trims/rejects empty the same way addPlayer's
   * name arg is sanitized by its own caller.
   */
  renameSeat(token: string, name: string): { ok: true } | { error: string } {
    if (this.started) return { error: "Can't rename after the game has started." };
    const trimmed = name.trim();
    if (!trimmed) return { error: "Name can't be empty." };
    const seat = this.requireSeatByToken(token);
    if ("error" in seat) return seat;
    seat.name = trimmed;
    if (this.isHost(token)) this.hostNameLabel = trimmed;
    this.onLobbyChange(this.getLobbyState());
    return { ok: true };
  }

  /**
   * A guest (never the host -- see room:end for closing the whole room instead)
   * leaving the lobby before the game starts. Frees the seat entirely (not just
   * marked disconnected) so the slot re-opens for someone else to join, and the
   * departing token stops working for any future rejoin.
   */
  leaveLobby(token: string): { ok: true } | { error: string } {
    if (this.started) return { error: "Can't leave once the game has started." };
    if (this.isHost(token)) return { error: "The host can't leave their own room -- close it instead." };
    const seat = this.requireSeatByToken(token);
    if ("error" in seat) return seat;
    this.seats.delete(seat.playerId);
    this.touch();
    this.onLobbyChange(this.getLobbyState());
    return { ok: true };
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

    // Placeholder names -- dealAndStart (called right below) reshuffles every AI
    // seat's name on every deal, this call included, so what's assigned here never
    // actually reaches a player's screen.
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
   * True for the host, same as isHost -- but also true for any real seated player in a
   * display-hosted (screencast) room, since that room's "host" is just the shared
   * screen and holds no player-facing token of its own. Without this, nobody actually
   * playing a screencast game could ever trigger "Play again" themselves; they'd be
   * stuck waiting on whoever's standing at the shared screen. Not extended to a
   * single-device room's guests -- there, a real host exists and rematch staying
   * host-only is the deliberate norm.
   */
  private canRematch(callerToken: string): boolean {
    if (this.isHost(callerToken)) return true;
    if (!this.displayHosted) return false;
    return [...this.seats.values()].some((s) => !s.isAI && s.token === callerToken);
  }

  /**
   * Host-only for a single-device room; any real seated player for a display-hosted
   * (screencast) one -- see canRematch. Deals a fresh game to the exact same seats
   * (same humans, same AI slots filled at the original Start) without touching the
   * room itself -- the same join link/lobby keeps working, nobody has to reconnect.
   * Deliberately allowed mid-game too (not just once the previous game has ended) --
   * whoever calls it may want to restart with a different AI difficulty or location
   * without waiting the current game out, same as single-player's always-available
   * "New Game". Discards whatever progress the in-progress game had; every other
   * seated player just sees a fresh board appear on their next state push.
   * `centerEffect` can change the location for this next game (unlike player count,
   * which is fixed to the seats already at the table) -- already resolved from
   * "random" by the caller, same as room:create. `centerEffectMode` carries the raw,
   * unresolved choice alongside it purely so every future viewer's own LobbyState
   * stays accurate (see its doc comment); defaults to `centerEffect` for a caller that
   * never had a "random" concept. `aiDifficulty` can change too, same reasoning as the
   * location.
   */
  rematch(
    callerToken: string,
    centerEffect: CenterEffectId,
    aiDifficulty: AiDifficulty,
    centerEffectMode: CenterEffectId | "random" = centerEffect
  ): { ok: true } | { error: string } {
    if (!this.canRematch(callerToken)) return { error: "Only a seated player can start a new game." };
    if (!this.state) return { error: "The game hasn't started yet." };

    this.centerEffect = centerEffect;
    this.centerEffectMode = centerEffectMode;
    this.aiDifficulty = aiDifficulty;
    this.dealAndStart();
    this.onLobbyChange(this.getLobbyState());
    return { ok: true };
  }

  /**
   * Screencast (display-hosted) rooms only: registers `callerToken`'s seat as ready
   * for the next game, then actually deals it the moment every real seated player has
   * done the same -- a one-way "click and can't unclick" readiness gate, deliberately
   * not a toggle. Reuses the room's own stored centerEffect/centerEffectMode/
   * aiDifficulty (same settings "Play again" always reused), resolving a fresh
   * location itself when centerEffectMode is "random" -- unlike rematch() above, no
   * caller ever gets to hand in an already-resolved value here, since the whole point
   * is that any one of several players' clicks might be the one that finally triggers
   * the deal, and none of them should need to carry the room's settings themselves.
   * A normal single-device room has no use for this (there's always exactly one real
   * host, no "everyone" to wait on) -- it keeps using rematch() directly, unchanged.
   */
  readyForRematch(callerToken: string): { ok: true } | { error: string } {
    if (!this.displayHosted) return { error: "This room doesn't need everyone to ready up." };
    if (!this.state || this.state.phase !== "ended") return { error: "The game hasn't ended yet." };
    const seat = [...this.seats.values()].find((s) => !s.isAI && s.token === callerToken);
    if (!seat) return { error: "Only a real seated player can ready up." };

    this.rematchReady.add(seat.playerId);
    const realSeatIds = [...this.seats.values()].filter((s) => !s.isAI).map((s) => s.playerId);
    if (realSeatIds.every((id) => this.rematchReady.has(id))) {
      const rand = this.rng ?? Math.random;
      const centerEffect =
        this.centerEffectMode === "random"
          ? (() => {
              const pool = randomCenterEffectPool(this.playerCount);
              return pool[Math.floor(rand() * pool.length)];
            })()
          : this.centerEffectMode;
      this.centerEffect = centerEffect;
      this.dealAndStart(); // clears rematchReady itself, see its own doc comment
    }
    this.onLobbyChange(this.getLobbyState());
    return { ok: true };
  }

  /**
   * Shared by start() and rematch() -- deals a fresh GameState to the current seat
   * lineup and kicks off play. Cancels any AI turn timer still pending from whatever
   * game came before (only ever possible via a mid-game rematch, which can now catch
   * an AI's move mid-flight) -- without this, that stale timer would later fire against
   * the just-dealt state instead of the abandoned one, since it reads `this.state`
   * fresh rather than capturing it up front.
   */
  private dealAndStart(): void {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    this.rematchReady.clear();
    const rand = this.rng ?? Math.random;
    const seatOrder = [...this.seats.keys()];
    // Shuffled fresh every deal (not just a random starting index into the seats'
    // fixed insertion order) -- so who follows whom in turn order actually varies
    // game to game, including on a rematch/continue, instead of only ever rotating
    // the same fixed relative sequence to a different starting point. seatOrder
    // itself (unshuffled) is passed through separately as colorOrder so each seat
    // keeps its own stable color across every game despite turn order moving --
    // see PlayerState.colorIndex's own doc comment for why these two can't share
    // the same array.
    this.matchStartedAt = Date.now();
    const allIds = shuffle(seatOrder, rand);
    const aiSeats = [...this.seats.values()].filter((s) => s.isAI);
    // Reassigned fresh on every deal too, same reasoning as turn order above -- a
    // rematch/continue re-fills the SAME seats rather than recreating them, so
    // without this an AI seat's name would only ever have been randomized once, at
    // whatever the room's very first Start happened to roll.
    const shuffledAiNames = shuffle(AI_NAMES, rand);
    aiSeats.forEach((seat, i) => {
      seat.name = shuffledAiNames[i % shuffledAiNames.length];
    });
    const aiIds = aiSeats.map((s) => s.playerId);
    const config = configForPlayerCount(this.playerCount, this.centerEffect, this.aiDifficulty, rand);
    this.setState(createGame(allIds, config, this.rng, aiIds, 0, seatOrder));
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
    const resolved = resolveBoard(
      state.board,
      state.config.boardBounds,
      state.round,
      state.config.centerEffect,
      state.players.map((p) => p.id)
    );
    tallyGame(this.roomCardStats, resolved.cards, state.result.scores, this.playerCount, state.round, state.config.centerEffect);
    this.onLobbyChange(this.getLobbyState());

    const humanSeats = [...this.seats.values()].filter((s) => !s.isAI).length;
    logEvent("match_ended", {
      roomCode: this.roomCode,
      mode: this.displayHosted ? "screencast" : "multiplayer",
      playerCount: this.playerCount,
      humanSeats,
      centerEffect: state.config.centerEffect,
      aiDifficulty: this.aiDifficulty,
      rounds: state.round,
      durationMs: Date.now() - this.matchStartedAt,
    });
  }

  dispatch(callerToken: string, action: GameAction): { ok: true } | { error: string } {
    const caller = this.requireSeatByToken(callerToken);
    if ("error" in caller) return caller;
    if (!this.state) return { error: "This game hasn't started yet." };
    if (action.playerId !== caller.playerId) return { error: "You can't act on another player's behalf." };

    let next: GameState;
    try {
      next = applyAction(this.state, action, this.rng, this.computeVote);
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

      // Diagnostic only -- see the "AI is slower in multiplayer" investigation this
      // instrumentation exists to feed. computeMs isolates the AI search itself (the
      // suspected event-loop-blocking cost, since it runs synchronously on the same
      // process every other room's socket handling shares); totalMs also includes
      // setState's redaction/serialize/broadcast fan-out to every seat, which earlier
      // analysis found cheap at this game's scale but is logged alongside computeMs
      // anyway so that assumption stays checkable against a real session instead of
      // just this file's own comments.
      const startedAt = performance.now();
      const action = chooseAiActionForDifficulty(this.state, activeId, this.state.config.aiDifficulty, this.rng);
      const computeMs = performance.now() - startedAt;
      this.setState(applyAction(this.state, action, this.rng, this.computeVote));
      const totalMs = performance.now() - startedAt;
      console.log(
        `[ai-timing] room=${this.roomCode} difficulty=${this.aiDifficulty} action=${action.type} computeMs=${computeMs.toFixed(1)} totalMs=${totalMs.toFixed(1)}`
      );

      this.scheduleAiTurnIfNeeded();
    }, AI_TURN_DELAY_MS);
  }

  /** Cancels any pending AI-turn timer -- call when a room is torn down so it doesn't keep the process alive or fire against a discarded session. */
  dispose(): void {
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.aiTimer = null;
  }
}
