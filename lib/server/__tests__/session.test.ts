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
function harness(playerCount: number, seed = 1, displayHosted = false, aiDifficulty: AiDifficulty = "medium") {
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
    aiDifficulty
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

  it("getSummary reports the host's name and seated human count, not AI slots (none exist pre-start anyway)", () => {
    const { session } = harness(3);
    session.addPlayer("Guest");
    const summary = session.getSummary();
    expect(summary).toEqual({
      roomCode: "TEST",
      hostName: "Host",
      hostIsDisplay: false,
      seatedCount: 2,
      playerCount: 3,
      centerEffect: "none",
      started: false,
    });
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

  it("rejects rematch while a game is still in progress", () => {
    const { session, hostToken } = harness(2);
    session.start(hostToken);
    const result = session.rematch(hostToken, "none", "medium");
    expect(result).toMatchObject({ error: expect.any(String) });
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
