import { beforeEach, describe, expect, it, vi } from "vitest";
import { GameSession } from "../session";
import { DISPLAY_VIEWER_ID, fromWireState, LobbyState, WireGameState } from "../protocol";
import { currentPlayerId, getLegalPlacementCells } from "@/lib/engine/turns";
import { AiDifficulty } from "@/lib/engine/types";

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** Records every push a session makes, and captures the host's own token (GameSession exposes it via `.hostToken` -- see its doc comment for why that getter exists). */
function harness(playerCount: number, seed = 1, displayHosted = false, aiDifficulty: AiDifficulty = "medium", password?: string) {
  const lobbyPushes: LobbyState[] = [];
  const statePushes: { playerId: string; state: WireGameState }[] = [];
  const session = new GameSession(
    "TEST",
    "Host",
    playerCount,
    "none",
    "http://test.local:3000",
    {
      onLobbyChange: (lobby) => lobbyPushes.push(lobby),
      onPlayerState: (playerId, state) => statePushes.push({ playerId, state }),
    },
    deterministicRng(seed),
    displayHosted,
    aiDifficulty,
    password
  );
  return { session, lobbyPushes, statePushes, hostToken: session.hostToken };
}

/**
 * Drives a real game to completion by playing the host's own turns (voting to end
 * the moment it's allowed) and letting AI turns run via fake timers -- roundCap
 * guarantees termination regardless of votes, so this always finishes. Used by tests
 * that need an actually-ended game (e.g. rematch, which is only legal post-game).
 * Must be called with fake timers already active.
 */
async function playUntilEnded(session: GameSession, hostToken: string, statePushes: { playerId: string; state: WireGameState }[]) {
  for (let guard = 0; guard < 300; guard++) {
    await vi.advanceTimersByTimeAsync(700);
    const hostPush = [...statePushes].reverse().find((p) => p.playerId === session.hostPlayerId);
    if (!hostPush) continue;
    const state = fromWireState(hostPush.state);
    if (state.phase === "ended") return state;

    if (state.phase === "voting") {
      if (!(session.hostPlayerId in state.votes)) {
        session.dispatch(hostToken, { type: "castVote", playerId: session.hostPlayerId, vote: true });
      }
      continue;
    }

    if (currentPlayerId(state) !== session.hostPlayerId) continue;
    const player = state.players.find((p) => p.id === session.hostPlayerId)!;
    const legalCells = getLegalPlacementCells(state);
    if (player.hand.length === 0 || legalCells.length === 0) {
      session.dispatch(hostToken, { type: "pass", playerId: session.hostPlayerId });
    } else {
      session.dispatch(hostToken, {
        type: "place",
        playerId: session.hostPlayerId,
        instanceId: player.hand[0].instanceId,
        position: legalCells[0],
      });
    }
  }
  throw new Error("playUntilEnded: game never ended within the guard limit");
}

/**
 * Same idea as playUntilEnded, but drives one or more given real seats' own turns
 * instead of always the host's -- needed for display-hosted rooms, where hostPlayerId
 * is DISPLAY_VIEWER_ID and never actually has a turn to take (see readyForRematch's
 * tests, which need real, non-host seats to reach "ended" itself). `tokensByPlayerId`
 * covers every real seat that needs driving -- any seat NOT in it is assumed to be AI,
 * playing itself via the session's own timers.
 *
 * Reads phase/currentPlayerId off *any* of our own players' pushes (identical on
 * every redacted copy), but always reads the ACTING player's own push to decide their
 * hand/legal cells -- a hidden-info redacted view of a DIFFERENT player's hand isn't
 * their real hand (usually empty/hidden), and driving off the wrong one causes a
 * dispatch to be rejected as illegal even when the real player genuinely has a move.
 */
async function playUntilEndedAsPlayers(
  session: GameSession,
  tokensByPlayerId: Map<string, string>,
  statePushes: { playerId: string; state: WireGameState }[]
) {
  const [anyPlayerId] = tokensByPlayerId.keys();
  for (let guard = 0; guard < 300; guard++) {
    await vi.advanceTimersByTimeAsync(700);
    const anyPush = [...statePushes].reverse().find((p) => p.playerId === anyPlayerId);
    if (!anyPush) continue;
    const anyState = fromWireState(anyPush.state);
    if (anyState.phase === "ended") return anyState;

    if (anyState.phase === "voting") {
      for (const [playerId, token] of tokensByPlayerId) {
        if (!(playerId in anyState.votes)) session.dispatch(token, { type: "castVote", playerId, vote: true });
      }
      continue;
    }

    const activeId = currentPlayerId(anyState);
    const token = tokensByPlayerId.get(activeId);
    if (!token) continue; // not one of ours -- an AI seat, plays itself via its own timer

    const activePush = [...statePushes].reverse().find((p) => p.playerId === activeId);
    if (!activePush) continue;
    const activeState = fromWireState(activePush.state);
    const player = activeState.players.find((p) => p.id === activeId)!;
    const legalCells = getLegalPlacementCells(activeState);
    if (player.hand.length === 0 || legalCells.length === 0) {
      session.dispatch(token, { type: "pass", playerId: activeId });
    } else {
      session.dispatch(token, { type: "place", playerId: activeId, instanceId: player.hand[0].instanceId, position: legalCells[0] });
    }
  }
  throw new Error("playUntilEndedAsPlayers: game never ended within the guard limit");
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("GameSession lobby", () => {
  it("seats the host on creation, not yet started", () => {
    const { session } = harness(2);
    const lobby = session.getLobbyState();
    expect(lobby.started).toBe(false);
    expect(lobby.hostPlayerId).toBe(session.hostPlayerId);
    expect(lobby.seats).toHaveLength(1);
    expect(lobby.seats[0]).toMatchObject({ playerId: session.hostPlayerId, name: "Host", isAI: false, connected: true });
  });

  it("carries the server-provided origin through the lobby state, not a client-relative URL", () => {
    const { session } = harness(2);
    expect(session.getLobbyState().serverOrigin).toBe("http://test.local:3000");
  });

  it("addPlayer seats a new human and broadcasts the lobby", () => {
    const { session, lobbyPushes } = harness(3);
    const result = session.addPlayer("Guest");
    expect("error" in result).toBe(false);
    expect(session.getLobbyState().seats).toHaveLength(2);
    expect(lobbyPushes.at(-1)?.seats.map((s) => s.name)).toEqual(["Host", "Guest"]);
  });

  it("rejects a new player once human seats fill playerCount", () => {
    const { session } = harness(2);
    session.addPlayer("Guest");
    const result = session.addPlayer("OneTooMany");
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("rejects a second FRESH join from a device that already holds a seat in this room", () => {
    const { session } = harness(3);
    expect("error" in session.addPlayer("Guest1", undefined, "device-1")).toBe(false);
    const result = session.addPlayer("Guest2", undefined, "device-1");
    expect(result).toEqual({ error: "This device already has a seat in this room." });
  });

  it("lets different devices each take their own seat", () => {
    const { session } = harness(3);
    expect("error" in session.addPlayer("Guest1", undefined, "device-1")).toBe(false);
    expect("error" in session.addPlayer("Guest2", undefined, "device-2")).toBe(false);
  });

  it("never applies the device guard when no deviceId is supplied -- callers with no real device id skip the check entirely", () => {
    const { session } = harness(3);
    expect("error" in session.addPlayer("Guest1")).toBe(false);
    expect("error" in session.addPlayer("Guest2")).toBe(false);
  });

  it("also guards against the HOST's own device id, not just seats created via addPlayer", () => {
    // Host seat is created with hostDeviceId="device-1" via the constructor directly
    // (harness doesn't thread it through) -- confirms addPlayer's guard checks it too,
    // not just seats it created itself.
    const session = new GameSession(
      "TEST",
      "Host",
      3,
      "none",
      "http://test.local:3000",
      { onLobbyChange: () => {}, onPlayerState: () => {} },
      deterministicRng(1),
      false,
      "medium",
      undefined,
      "device-1"
    );
    const result = session.addPlayer("Guest", undefined, "device-1");
    expect(result).toEqual({ error: "This device already has a seat in this room." });
  });

  it("getSummary reports the host's name and seated human count, not AI slots (none exist pre-start anyway)", () => {
    const { session } = harness(3);
    session.addPlayer("Guest");
    const summary = session.getSummary();
    expect(summary).toEqual({
      roomCode: "TEST",
      hostPlayerId: expect.any(String),
      hostName: "Host",
      hostIsDisplay: false,
      seatedCount: 2,
      playerCount: 3,
      centerEffect: "none",
      started: false,
      hasPassword: false,
    });
  });

  it("rejects a join with a missing or wrong password when the room was created with one", () => {
    const { session } = harness(3, 1, false, "medium", "hunter2");
    expect(session.addPlayer("Guest")).toEqual({ error: "Incorrect room password." });
    expect(session.addPlayer("Guest", "wrong")).toEqual({ error: "Incorrect room password." });
  });

  it("accepts a join with the matching password", () => {
    const { session } = harness(3, 1, false, "medium", "hunter2");
    const result = session.addPlayer("Guest", "hunter2");
    expect("error" in result).toBe(false);
  });

  it("normalizes the password to uppercase at construction and compares case-insensitively", () => {
    const { session } = harness(3, 1, false, "medium", "Secret1");
    expect(session.password).toBe("SECRET1");
    expect("error" in session.addPlayer("Guest", "secret1")).toBe(false);
  });

  it("getSummary reports hasPassword without leaking the password itself", () => {
    const { session } = harness(3, 1, false, "medium", "hunter2");
    expect(session.getSummary().hasPassword).toBe(true);
    expect(JSON.stringify(session.getSummary())).not.toContain("hunter2");
  });

  it("treats a blank/whitespace-only password as no password at all", () => {
    const { session } = harness(3, 1, false, "medium", "   ");
    expect(session.getSummary().hasPassword).toBe(false);
    expect("error" in session.addPlayer("Guest")).toBe(false);
  });

  it("lets an already-seated player rejoin by token without ever re-supplying the password", () => {
    const { session, hostToken } = harness(3, 1, false, "medium", "hunter2");
    const result = session.rejoin(hostToken);
    expect("error" in result).toBe(false);
  });

  it("rejects joining after the game has started", () => {
    const { session, hostToken } = harness(2);
    session.start(hostToken);
    const result = session.addPlayer("TooLate");
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});

describe("GameSession display-hosted (Jackbox-style shared screen)", () => {
  it("seats no one for the host -- all playerCount seats are open for real players/AI", () => {
    const { session } = harness(3, 1, true);
    const lobby = session.getLobbyState();
    expect(lobby.hostIsDisplay).toBe(true);
    expect(lobby.hostPlayerId).toBe(DISPLAY_VIEWER_ID);
    expect(lobby.seats).toHaveLength(0);
    expect(session.hostPlayerId).toBe(DISPLAY_VIEWER_ID);
  });

  it("lets all playerCount seats fill with real players, unlike a single-device host which reserves one for itself", () => {
    const { session } = harness(2, 1, true);
    expect("error" in session.addPlayer("Alice")).toBe(false);
    expect("error" in session.addPlayer("Bob")).toBe(false);
    const result = session.addPlayer("OneTooMany");
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("start/rematch/isHost/end all authorize off the standalone host token, not a seat", () => {
    const { session, hostToken } = harness(2, 1, true);
    expect(session.isHost(hostToken)).toBe(true);
    expect(session.isHost("not-the-token")).toBe(false);
    session.addPlayer("Alice");
    session.addPlayer("Bob");
    const result = session.start(hostToken);
    expect("error" in result).toBe(false);
    expect(session.started).toBe(true);
  });

  it("rejects start from a real seated player's own token -- only the display's host token can start", () => {
    const { session } = harness(2, 1, true);
    const alice = session.addPlayer("Alice") as { playerId: string; token: string };
    session.addPlayer("Bob");
    const result = session.start(alice.token);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("pushes a fully redacted (nobody's) state to the display on every state change", () => {
    const { session, hostToken, statePushes } = harness(2, 1, true);
    session.addPlayer("Alice");
    session.addPlayer("Bob");
    session.start(hostToken);
    const displayPush = [...statePushes].reverse().find((p) => p.playerId === DISPLAY_VIEWER_ID);
    expect(displayPush).toBeDefined();
    const state = fromWireState(displayPush!.state);
    expect(state.players.every((p) => p.hand.length === 0)).toBe(true);
    expect(state.deck).toHaveLength(0);
  });

  it("rejoin re-attaches the display's pseudo-identity via its standalone token", () => {
    const { session, hostToken } = harness(2, 1, true);
    session.addPlayer("Alice");
    session.addPlayer("Bob");
    session.start(hostToken);
    const result = session.rejoin(hostToken);
    expect(result).toEqual({ playerId: DISPLAY_VIEWER_ID });
  });

  it("getSummary/getLobbyState report hostIsDisplay without a real host seat backing hostName", () => {
    const { session } = harness(4, 1, true);
    expect(session.getSummary()).toMatchObject({ hostName: "Host", hostIsDisplay: true, seatedCount: 0, playerCount: 4 });
  });
});

describe("GameSession start / dispatch", () => {
  it("fills remaining seats with AI and deals a real game on start", () => {
    const { session, hostToken, statePushes } = harness(2);
    const started = session.start(hostToken);
    expect(started).toEqual({ ok: true });

    const lobby = session.getLobbyState();
    expect(lobby.started).toBe(true);
    expect(lobby.seats).toHaveLength(2);
    expect(lobby.seats.some((s) => s.isAI)).toBe(true);

    // Every seat should have received its own (redacted) state push.
    const pushedTo = new Set(statePushes.map((p) => p.playerId));
    expect(pushedTo).toEqual(new Set(lobby.seats.map((s) => s.playerId)));
  });

  it("rejects start from a non-host token", () => {
    const { session } = harness(2);
    const guest = session.addPlayer("Guest") as { playerId: string; token: string };
    const result = session.start(guest.token);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(session.started).toBe(false);
  });

  it("redacts each player's pushed state -- nobody's hand shows up in another player's push", () => {
    const { session, hostToken, statePushes } = harness(3);
    session.addPlayer("Guest");
    session.start(hostToken);

    const lastPushByPlayer = new Map<string, WireGameState>();
    for (const { playerId, state } of statePushes) lastPushByPlayer.set(playerId, state);

    for (const [viewerId, state] of lastPushByPlayer) {
      for (const player of state.players) {
        if (player.id !== viewerId) expect(player.hand).toHaveLength(0);
      }
    }
  });

  it("dispatch rejects an action from an unrecognized token", () => {
    const { session, hostToken } = harness(2);
    session.start(hostToken);
    const result = session.dispatch("not-a-real-token", { type: "pass", playerId: session.hostPlayerId });
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("dispatch rejects acting on another player's behalf", () => {
    const { session, hostToken } = harness(2);
    session.start(hostToken);
    const result = session.dispatch(hostToken, { type: "pass", playerId: "someone-else" });
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("dispatch before start is rejected", () => {
    const { session, hostToken } = harness(2);
    const result = session.dispatch(hostToken, { type: "pass", playerId: session.hostPlayerId });
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});

describe("GameSession rematch", () => {
  it("rejects rematch before the game has ever started", () => {
    const { session, hostToken } = harness(2);
    const result = session.rematch(hostToken, "none", "medium");
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("rejects rematch from a non-host token, even mid-game", () => {
    const { session, hostToken } = harness(2);
    const guest = session.addPlayer("Guest") as { playerId: string; token: string };
    session.start(hostToken);
    const result = session.rematch(guest.token, "none", "medium");
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("allows any real seated player to rematch in a display-hosted room -- there's no player-facing host token to restrict it to", () => {
    const { session, hostToken } = harness(2, 1, true);
    const guest = session.addPlayer("Guest") as { playerId: string; token: string };
    session.start(hostToken);
    const result = session.rematch(guest.token, "none", "medium");
    expect(result).toEqual({ ok: true });
  });

  it("still rejects an AI seat's token in a display-hosted room -- only real seated players qualify", () => {
    const { session, hostToken } = harness(2, 1, true);
    session.start(hostToken);
    // Every seat in a 2-player display room is AI (no one called addPlayer), so any
    // fabricated token is guaranteed not to belong to a real seated player.
    const result = session.rematch("not-a-real-token", "none", "medium");
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("allows the host to force a new game mid-game, discarding the current one", () => {
    const { session, hostToken } = harness(2);
    session.start(hostToken);
    const result = session.rematch(hostToken, "none", "medium");
    expect(result).toEqual({ ok: true });
    expect(session.getLobbyState().seats).toHaveLength(2);
  });

  it("cancels a pending AI-turn timer when forced mid-game, so it never fires against the wrong game", async () => {
    vi.useFakeTimers();
    // displayHosted -- every one of the 3 seats is AI (a display host takes no seat of
    // its own), so whoever's up first after start() is guaranteed to be AI and its
    // move timer guaranteed pending, regardless of the randomized firstPlayerIndex.
    const { session, hostToken, statePushes } = harness(3, 1, true);
    session.start(hostToken);
    // Force a new game immediately, before the pending AI timer (AI_TURN_DELAY_MS)
    // fires -- without dealAndStart's fix, that stale timer would later read
    // `this.state` fresh and apply an AI move against the just-dealt game instead of
    // the abandoned one.
    const result = session.rematch(hostToken, "none", "medium");
    expect(result).toEqual({ ok: true });

    await vi.advanceTimersByTimeAsync(600);
    const freshState = fromWireState(statePushes.at(-1)!.state);
    // Still round 1 with at most one action applied (the fresh game's own first AI
    // move, scheduled anew by dealAndStart) -- never two AI moves deep, which is what
    // an uncancelled stale timer plus the fresh game's own timer firing back-to-back
    // would produce.
    expect(freshState.round).toBe(1);
    expect(freshState.board.size).toBeLessThanOrEqual(1);

    vi.useRealTimers();
  });

  it("deals a fresh game to the same seats once the previous one ends, keeping the room intact", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    const seatsAtStart = session.getLobbyState().seats.map((s) => s.playerId);

    const ended = await playUntilEnded(session, hostToken, statePushes);
    expect(ended.phase).toBe("ended");
    expect(ended.result).not.toBeNull();

    const pushCountBefore = statePushes.length;
    const result = session.rematch(hostToken, "none", "medium");
    expect(result).toEqual({ ok: true });

    // Same room, same roomCode/seats -- rematch never leaves the registry, so no new
    // join link is needed.
    expect(session.roomCode).toBe("TEST");
    expect(session.getLobbyState().seats.map((s) => s.playerId)).toEqual(seatsAtStart);

    // A genuinely new game: back to "playing", empty board, round 1.
    await vi.advanceTimersByTimeAsync(0);
    expect(statePushes.length).toBeGreaterThan(pushCountBefore);
    const freshState = fromWireState(statePushes.at(-1)!.state);
    expect(freshState.phase).toBe("playing");
    expect(freshState.round).toBe(1);
    expect(freshState.board.size).toBe(0);

    vi.useRealTimers();
  });

  it("can change the location for the rematch -- reflected in the lobby, unlike player count", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    await playUntilEnded(session, hostToken, statePushes);

    const result = session.rematch(hostToken, "shadowlands", "medium");
    expect(result).toEqual({ ok: true });
    expect(session.getLobbyState().centerEffect).toBe("shadowlands");

    await vi.advanceTimersByTimeAsync(0);
    const freshState = fromWireState(statePushes.at(-1)!.state);
    expect(freshState.config.centerEffect).toBe("shadowlands");

    vi.useRealTimers();
  });

  it("defaults centerEffectMode to the resolved centerEffect when the room was never told about 'random'", () => {
    const { session } = harness(2);
    expect(session.getLobbyState().centerEffectMode).toBe("none");
  });

  it("keeps centerEffectMode server-authoritative across a rematch, so every viewer (not just whoever created the room) can tell a room was set to reroll on every rematch", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    await playUntilEnded(session, hostToken, statePushes);

    const result = session.rematch(hostToken, "shadowlands", "medium", "random");
    expect(result).toEqual({ ok: true });
    expect(session.getLobbyState().centerEffectMode).toBe("random");
    // The resolved value is still the concrete id actually dealt -- "random" is only
    // ever the raw mode, never a real GameConfig.centerEffect value.
    expect(session.getLobbyState().centerEffect).toBe("shadowlands");

    vi.useRealTimers();
  });

  it("deals the game with whatever AI difficulty the room was created with", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2, 1, false, "easy");
    session.start(hostToken);
    await vi.advanceTimersByTimeAsync(0);

    const freshState = fromWireState(statePushes.at(-1)!.state);
    expect(freshState.config.aiDifficulty).toBe("easy");

    vi.useRealTimers();
  });

  it("can change the AI difficulty for the rematch, same as the location", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    await playUntilEnded(session, hostToken, statePushes);

    const result = session.rematch(hostToken, "none", "hard");
    expect(result).toEqual({ ok: true });

    await vi.advanceTimersByTimeAsync(0);
    const freshState = fromWireState(statePushes.at(-1)!.state);
    expect(freshState.config.aiDifficulty).toBe("hard");

    vi.useRealTimers();
  });
});

describe("GameSession readyForRematch", () => {
  it("rejects it entirely for a normal (non-display) room", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    await playUntilEnded(session, hostToken, statePushes);

    const result = session.readyForRematch(hostToken);
    expect(result).toMatchObject({ error: expect.any(String) });

    vi.useRealTimers();
  });

  it("rejects it before the game has ended", () => {
    const { session, hostToken } = harness(2, 1, true);
    const alice = session.addPlayer("Alice") as { playerId: string; token: string };
    session.start(hostToken);
    const result = session.readyForRematch(alice.token);
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("doesn't deal a fresh game until every real seated player has readied up", async () => {
    vi.useFakeTimers();
    // 3 seats, only 2 real (Alice, Bob) -- the third fills with AI at start() and
    // plays itself, so readiness only ever needs to wait on the two real ones.
    const { session, hostToken, statePushes } = harness(3, 1, true);
    const alice = session.addPlayer("Alice") as { playerId: string; token: string };
    const bob = session.addPlayer("Bob") as { playerId: string; token: string };
    session.start(hostToken);
    const ended = await playUntilEndedAsPlayers(
      session,
      new Map([
        [alice.playerId, alice.token],
        [bob.playerId, bob.token],
      ]),
      statePushes
    );
    expect(ended.phase).toBe("ended");

    const pushCountBefore = statePushes.length;
    const aliceResult = session.readyForRematch(alice.token);
    expect(aliceResult).toEqual({ ok: true });
    expect(session.getLobbyState().rematchReadyPlayerIds).toEqual([alice.playerId]);

    // Still just the one seat readied -- no fresh game dealt yet, so no new state push.
    await vi.advanceTimersByTimeAsync(0);
    expect(statePushes.length).toBe(pushCountBefore);
    const stillEnded = fromWireState(statePushes.at(-1)!.state);
    expect(stillEnded.phase).toBe("ended");

    const bobResult = session.readyForRematch(bob.token);
    expect(bobResult).toEqual({ ok: true });

    await vi.advanceTimersByTimeAsync(0);
    const freshState = fromWireState(statePushes.at(-1)!.state);
    expect(freshState.phase).toBe("playing");
    expect(freshState.round).toBe(1);
    // The readiness set is cleared the moment the fresh game deals, ready for the game
    // after this one.
    expect(session.getLobbyState().rematchReadyPlayerIds).toEqual([]);

    vi.useRealTimers();
  });

  it("rejects a fabricated/AI token -- only a real seated player's own token counts", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(3, 1, true);
    const alice = session.addPlayer("Alice") as { playerId: string; token: string };
    const bob = session.addPlayer("Bob") as { playerId: string; token: string };
    session.start(hostToken);
    await playUntilEndedAsPlayers(
      session,
      new Map([
        [alice.playerId, alice.token],
        [bob.playerId, bob.token],
      ]),
      statePushes
    );

    const result = session.readyForRematch("not-a-real-token");
    expect(result).toMatchObject({ error: expect.any(String) });

    vi.useRealTimers();
  });
});

describe("GameSession roomStats", () => {
  it("is empty until the first game in the room ends", () => {
    const { session, hostToken } = harness(2);
    expect(session.getLobbyState().roomStats).toEqual([]);
    session.start(hostToken);
    expect(session.getLobbyState().roomStats).toEqual([]);
  });

  it("tallies every seat once the game ends, winner included", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    const ended = await playUntilEnded(session, hostToken, statePushes);

    const stats = session.getLobbyState().roomStats;
    expect(stats).toHaveLength(2);
    for (const entry of stats) {
      expect(entry.games).toBe(1);
      const isWinner = ended.result!.winnerIds.includes(entry.playerId);
      expect(entry.wins).toBe(isWinner ? 1 : 0);
      // 2p: placementDeltaSum is exactly -1 for the winner, +1 for the loser (see
      // placementBaseline/placementMaxDeviation at playerCount=2) -- a tie would give
      // both seats rank 1 and so both a -1, but the deterministic seed/roundCap combo
      // here reliably produces a clean win, matching every other rematch test above.
      expect(entry.placementDeltaSum).toBe(isWinner ? -1 : 1);
    }

    vi.useRealTimers();
  });

  it("keeps accumulating across rematches instead of resetting -- same lobby, running total", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    await playUntilEnded(session, hostToken, statePushes);

    const afterFirstGame = session.getLobbyState().roomStats;
    expect(afterFirstGame.every((e) => e.games === 1)).toBe(true);

    session.rematch(hostToken, "none", "medium");
    await playUntilEnded(session, hostToken, statePushes);

    const afterSecondGame = session.getLobbyState().roomStats;
    expect(afterSecondGame).toHaveLength(2);
    expect(afterSecondGame.every((e) => e.games === 2)).toBe(true);
    // Total wins across both seats always equals the number of games played (2) --
    // every game has exactly one winner at this seed (no ties), win or loss.
    expect(afterSecondGame.reduce((sum, e) => sum + e.wins, 0)).toBe(2);

    vi.useRealTimers();
  });

  it("broadcasts a fresh lobby the moment the game ends, even though no seat changed", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes, lobbyPushes } = harness(2);
    session.start(hostToken);
    const pushCountBefore = lobbyPushes.length;
    await playUntilEnded(session, hostToken, statePushes);

    expect(lobbyPushes.length).toBeGreaterThan(pushCountBefore);
    expect(lobbyPushes.at(-1)!.roomStats.every((e) => e.games === 1)).toBe(true);

    vi.useRealTimers();
  });

  it("tallies a per-card breakdown alongside the per-seat stats, empty until the first game ends", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    expect(session.getLobbyState().roomCardStats.every((row) => row.played === 0)).toBe(true);
    session.start(hostToken);
    expect(session.getLobbyState().roomCardStats.every((row) => row.played === 0)).toBe(true);
    await playUntilEnded(session, hostToken, statePushes);

    const cardStats = session.getLobbyState().roomCardStats;
    expect(cardStats.length).toBeGreaterThan(0);
    expect(cardStats.some((row) => row.played > 0)).toBe(true);

    vi.useRealTimers();
  });

  it("keeps accumulating card stats across rematches instead of resetting", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);
    await playUntilEnded(session, hostToken, statePushes);
    const afterFirstGame = session.getLobbyState().roomCardStats;
    const totalPlayedAfterFirst = afterFirstGame.reduce((sum, row) => sum + row.played, 0);

    session.rematch(hostToken, "none", "medium");
    await playUntilEnded(session, hostToken, statePushes);
    const afterSecondGame = session.getLobbyState().roomCardStats;
    const totalPlayedAfterSecond = afterSecondGame.reduce((sum, row) => sum + row.played, 0);

    expect(totalPlayedAfterSecond).toBeGreaterThan(totalPlayedAfterFirst);

    vi.useRealTimers();
  });
});

describe("GameSession AI turns", () => {
  it("plays out AI turns on its own once it becomes an AI seat's turn", async () => {
    vi.useFakeTimers();
    const { session, hostToken, statePushes } = harness(2);
    session.start(hostToken);

    const lobby = session.getLobbyState();
    const aiSeat = lobby.seats.find((s) => s.isAI)!;
    const hostState = statePushes.find((p) => p.playerId === session.hostPlayerId)!.state;

    if (hostState.currentPlayerIndex !== hostState.players.findIndex((p) => p.id === aiSeat.playerId)) {
      // Host went first this time (firstPlayerIndex is randomized) -- take a real
      // human turn so play reaches the AI seat, then let its timers run.
      const legalPos = { x: hostState.config.boardBounds.center.x, y: hostState.config.boardBounds.center.y - 1 };
      const hostPlayer = hostState.players.find((p) => p.id === session.hostPlayerId)!;
      session.dispatch(hostToken, {
        type: "place",
        playerId: session.hostPlayerId,
        instanceId: hostPlayer.hand[0].instanceId,
        position: legalPos,
      });
    }

    const pushCountBefore = statePushes.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(statePushes.length).toBeGreaterThan(pushCountBefore);

    const latestForHost = [...statePushes].reverse().find((p) => p.playerId === session.hostPlayerId)!;
    // The AI should have placed at least one card by now.
    expect(Object.keys(latestForHost.state.board).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});

describe("GameSession rejoin/disconnect", () => {
  it("marks a player disconnected and reconnects them via rejoin", () => {
    const { session, lobbyPushes } = harness(2);
    const guest = session.addPlayer("Guest") as { playerId: string; token: string };

    session.markDisconnected(guest.playerId);
    expect(lobbyPushes.at(-1)?.seats.find((s) => s.playerId === guest.playerId)?.connected).toBe(false);

    const rejoined = session.rejoin(guest.token);
    expect(rejoined).toEqual({ playerId: guest.playerId });
    expect(lobbyPushes.at(-1)?.seats.find((s) => s.playerId === guest.playerId)?.connected).toBe(true);
  });

  it("rejoin with an unknown token fails", () => {
    const { session } = harness(2);
    const result = session.rejoin("bogus-token");
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});

describe("GameSession isHost", () => {
  it("is true for the host's own token", () => {
    const { session, hostToken } = harness(2);
    expect(session.isHost(hostToken)).toBe(true);
  });

  it("is false for a guest's token", () => {
    const { session } = harness(2);
    const guest = session.addPlayer("Guest") as { playerId: string; token: string };
    expect(session.isHost(guest.token)).toBe(false);
  });

  it("is false for an unrecognized token", () => {
    const { session } = harness(2);
    expect(session.isHost("bogus-token")).toBe(false);
  });
});
