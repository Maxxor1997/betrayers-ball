import { describe, expect, it } from "vitest";
import { RoomRegistry } from "../rooms";
import { GameSession } from "../session";

function noopHandlers() {
  return { onLobbyChange: () => {}, onPlayerState: () => {} };
}

describe("RoomRegistry", () => {
  it("assigns a unique 4-character room code on create", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Host", 2, "none", "http://test.local:3000", noopHandlers()));
    expect(session.roomCode).toHaveLength(4);
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
    expect(summaries).toEqual([{ roomCode: session.roomCode, hostName: "Alice", seatedCount: 2, playerCount: 3, centerEffect: "none", started: false }]);
  });

  it("listSummaries still includes a room once it has started -- so a player who went back to home can find their way back in", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 2, "none", "http://test.local:3000", noopHandlers()));
    session.start(session.hostToken);

    const summaries = registry.listSummaries();
    expect(summaries).toEqual([{ roomCode: session.roomCode, hostName: "Alice", seatedCount: 1, playerCount: 2, centerEffect: "none", started: true }]);
  });

  it("delete removes a room from both get() and listSummaries()", () => {
    const registry = new RoomRegistry();
    const session = registry.create((roomCode) => new GameSession(roomCode, "Alice", 2, "none", "http://test.local:3000", noopHandlers()));
    registry.delete(session.roomCode);

    expect(registry.get(session.roomCode)).toBeUndefined();
    expect(registry.listSummaries()).toEqual([]);
  });
});
