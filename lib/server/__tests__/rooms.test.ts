import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomRegistry } from "../rooms";
import { ENDED_IDLE_TIMEOUT_MS, GameSession, UNSTARTED_IDLE_TIMEOUT_MS } from "../session";
import { fromWireState, WireGameState } from "../protocol";
import { ROOM_CODE_WORDS } from "../roomWords";
import { currentPlayerId, getLegalPlacementCells } from "@/lib/engine/turns";

function noopHandlers() {
  return { onLobbyChange: () => {}, onPlayerState: () => {} };
}

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** Same "play the host's own turns, vote to end ASAP, let AI turns run via fake timers" approach as session.test.ts's playUntilEnded -- duplicated locally (not imported) since it needs its own statePushes capture wired to a fresh session's handlers. */
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

describe("RoomRegistry", () => {
  it("assigns a room code that's an uppercased word from the room-word list", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Host", 2, "none", "http://test.local:3000", noopHandlers()));
    expect(ROOM_CODE_WORDS).toContain(session.roomCode.toLowerCase());
    expect(session.roomCode).toBe(session.roomCode.toUpperCase());
    expect(registry.get(session.roomCode)).toBe(session);
  });

  it("get is case-insensitive (room codes are always uppercase)", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Host", 2, "none", "http://test.local:3000", noopHandlers()));
    expect(registry.get(session.roomCode.toLowerCase())).toBe(session);
  });

  it("listSummaries includes a room still in its lobby", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 3, "none", "http://test.local:3000", noopHandlers()));
    session.addPlayer("Bob");

    const summaries = registry.listSummaries();
    expect(summaries).toEqual([{ roomCode: session.roomCode, hostName: "Alice", hostIsDisplay: false, seatedCount: 2, playerCount: 3, centerEffect: "none", started: false, hasPassword: false }]);
  });

  it("listSummaries still includes a room once it has started -- so a player who went back to home can find their way back in", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 2, "none", "http://test.local:3000", noopHandlers()));
    session.start(session.hostToken);

    const summaries = registry.listSummaries();
    expect(summaries).toEqual([{ roomCode: session.roomCode, hostName: "Alice", hostIsDisplay: false, seatedCount: 1, playerCount: 2, centerEffect: "none", started: true, hasPassword: false }]);
  });

  it("delete removes a room from both get() and listSummaries()", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 2, "none", "http://test.local:3000", noopHandlers()));
    registry.delete(session.roomCode);

    expect(registry.get(session.roomCode)).toBeUndefined();
    expect(registry.listSummaries()).toEqual([]);
  });
});

describe("RoomRegistry.reapIdleRooms", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves a fresh, unstarted lobby alone", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 2, "none", "http://test.local:3000", noopHandlers()));
    expect(registry.reapIdleRooms()).toEqual([]);
    expect(registry.get(session.roomCode)).toBe(session);
  });

  it("closes an unstarted lobby once it's been idle past UNSTARTED_IDLE_TIMEOUT_MS", () => {
    vi.useFakeTimers();
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 2, "none", "http://test.local:3000", noopHandlers()));

    vi.advanceTimersByTime(UNSTARTED_IDLE_TIMEOUT_MS - 1);
    expect(registry.reapIdleRooms()).toEqual([]);

    vi.advanceTimersByTime(2);
    expect(registry.reapIdleRooms()).toEqual([session.roomCode]);
    expect(registry.get(session.roomCode)).toBeUndefined();
  });

  it("a player joining resets the unstarted idle clock", () => {
    vi.useFakeTimers();
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 3, "none", "http://test.local:3000", noopHandlers()));

    vi.advanceTimersByTime(UNSTARTED_IDLE_TIMEOUT_MS - 1);
    session.addPlayer("Bob");
    vi.advanceTimersByTime(UNSTARTED_IDLE_TIMEOUT_MS - 1);

    // Almost 2x the timeout has passed in total, but Bob joining reset the clock partway through -- still not idle long enough since Bob joined.
    expect(registry.reapIdleRooms()).toEqual([]);
    expect(registry.get(session.roomCode)).toBe(session);
  });

  it("never closes a game that's still in progress, no matter how idle", () => {
    vi.useFakeTimers();
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 2, "none", "http://test.local:3000", noopHandlers(), deterministicRng(1)));
    session.start(session.hostToken);

    vi.advanceTimersByTime(ENDED_IDLE_TIMEOUT_MS * 10);
    expect(registry.reapIdleRooms()).toEqual([]);
    expect(registry.get(session.roomCode)).toBe(session);
  });

  it("closes a finished game once it's sat un-rematched/un-closed past ENDED_IDLE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const statePushes: { playerId: string; state: WireGameState }[] = [];
    const registry = new RoomRegistry();
    const session = registry.create(
      (roomCode) =>
        new GameSession(
          roomCode,
          "Alice",
          2,
          "none",
          "http://test.local:3000",
          { onLobbyChange: () => {}, onPlayerState: (playerId, state) => statePushes.push({ playerId, state }) },
          deterministicRng(1)
        )
    );
    session.start(session.hostToken);
    const ended = await playUntilEnded(session, session.hostToken, statePushes);
    expect(ended.phase).toBe("ended");

    // Generous margins (not an exact boundary check like the unstarted-lobby test
    // above) -- playUntilEnded's own polling loop advances the fake clock in 700ms
    // steps past the actual winning dispatch before it notices "ended" and returns,
    // so "now" here is already somewhat past the real last-touch time.
    vi.advanceTimersByTime(ENDED_IDLE_TIMEOUT_MS - 5000);
    expect(registry.reapIdleRooms()).toEqual([]);

    vi.advanceTimersByTime(5000 + 1000);
    expect(registry.reapIdleRooms()).toEqual([session.roomCode]);
    expect(registry.get(session.roomCode)).toBeUndefined();
  });

  it("a rematch resets the ended-idle clock (the room goes back to 'playing')", async () => {
    vi.useFakeTimers();
    const statePushes: { playerId: string; state: WireGameState }[] = [];
    const registry = new RoomRegistry();
    const session = registry.create(
      (roomCode) =>
        new GameSession(
          roomCode,
          "Alice",
          2,
          "none",
          "http://test.local:3000",
          { onLobbyChange: () => {}, onPlayerState: (playerId, state) => statePushes.push({ playerId, state }) },
          deterministicRng(1)
        )
    );
    session.start(session.hostToken);
    await playUntilEnded(session, session.hostToken, statePushes);

    vi.advanceTimersByTime(ENDED_IDLE_TIMEOUT_MS - 1);
    session.rematch(session.hostToken, "none", "medium");
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(ENDED_IDLE_TIMEOUT_MS * 10);
    // Back to "playing" from the rematch -- never auto-closed, same as any other in-progress game.
    expect(registry.reapIdleRooms()).toEqual([]);
    expect(registry.get(session.roomCode)).toBe(session);
  });

  it("only reaps rooms that are actually idle, leaving active ones", () => {
    vi.useFakeTimers();
    const registry = new RoomRegistry();
    const idle = registry.create((roomCode) => new GameSession(roomCode, "Idle", 2, "none", "http://test.local:3000", noopHandlers()));
    vi.advanceTimersByTime(UNSTARTED_IDLE_TIMEOUT_MS + 1);
    const fresh = registry.create((roomCode) => new GameSession(roomCode, "Fresh", 2, "none", "http://test.local:3000", noopHandlers()));

    expect(registry.reapIdleRooms()).toEqual([idle.roomCode]);
    expect(registry.get(idle.roomCode)).toBeUndefined();
    expect(registry.get(fresh.roomCode)).toBe(fresh);
  });
});
