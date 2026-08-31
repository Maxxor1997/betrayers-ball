import { describe, expect, it } from "vitest";
import { getVisibleBoard, redactedBoardFor, redactedStateFor } from "../playerView";
import { Board, CardInstance, GameConfig, GameState, posKey } from "../types";

let counter = 0;
function card(cardId: CardInstance["cardId"], ownerId: string, faceUp = false): CardInstance {
  return { instanceId: `c${counter++}`, cardId, ownerId, faceUp };
}

describe("getVisibleBoard", () => {
  it("reveals the viewer's own face-down cards", () => {
    const board: Board = new Map();
    const own = card("Exile", "p1", false);
    board.set(posKey({ x: 0, y: 0 }), own);

    const visible = getVisibleBoard(board, "p1");
    expect(visible.get("0,0")?.cardId).toBe("Exile");
  });

  it("hides an opponent's face-down card identity", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p2", false));

    const visible = getVisibleBoard(board, "p1");
    expect(visible.get("0,0")?.cardId).toBeNull();
  });

  it("reveals any face-up card regardless of owner", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Warlord", "p2", true));

    const visible = getVisibleBoard(board, "p1");
    expect(visible.get("0,0")?.cardId).toBe("Warlord");
  });

  it("always preserves instanceId, ownerId, and faceUp regardless of visibility", () => {
    const board: Board = new Map();
    const hidden = card("Suppressor", "p2", false);
    board.set(posKey({ x: 1, y: 1 }), hidden);

    const visible = getVisibleBoard(board, "p1").get("1,1")!;
    expect(visible.instanceId).toBe(hidden.instanceId);
    expect(visible.ownerId).toBe("p2");
    expect(visible.faceUp).toBe(false);
  });
});

describe("redactedBoardFor", () => {
  it("substitutes a hidden opponent card with the inert Unknown placeholder", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p2", false));

    const redacted = redactedBoardFor(board, "p1").get("0,0")!;
    expect(redacted.cardId).toBe("Unknown");
    expect(redacted.ownerId).toBe("p2");
    expect(redacted.faceUp).toBe(false);
  });

  it("leaves the viewer's own and any face-up card untouched", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p1", false));
    board.set(posKey({ x: 0, y: 1 }), card("Warlord", "p2", true));

    const redacted = redactedBoardFor(board, "p1");
    expect(redacted.get("0,0")?.cardId).toBe("Exile");
    expect(redacted.get("0,1")?.cardId).toBe("Warlord");
  });
});

const CONFIG: GameConfig = {
  boardBounds: { width: 3, height: 3, center: { x: 1, y: 1 } },
  handSize: 7,
  roundCap: 6,
  flipUnlockRound: 2,
  centerEffect: "none",
  minRoundFloor: 3,
  playerCount: 2,
  aiDifficulty: "medium",
};

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    config: CONFIG,
    board: new Map(),
    deck: [{ instanceId: "d1", cardId: "Footman" }],
    players: [
      { id: "p1", hand: [{ instanceId: "h1", cardId: "Footman", ownerId: "p1", faceUp: false }], isAI: false },
      { id: "p2", hand: [{ instanceId: "h2", cardId: "Exile", ownerId: "p2", faceUp: false }], isAI: false },
    ],
    currentPlayerIndex: 0,
    round: 2,
    turnsThisRound: 0,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    votes: { p1: true, p2: false },
    voteHistory: [],
    flipHistory: [],
    placementOrder: [],
    handOffers: {},
    phase: "voting",
    result: null,
    ...overrides,
  };
}

describe("redactedStateFor", () => {
  it("keeps the viewer's own hand but empties everyone else's", () => {
    const redacted = redactedStateFor(makeState(), "p1");
    expect(redacted.players.find((p) => p.id === "p1")?.hand).toHaveLength(1);
    expect(redacted.players.find((p) => p.id === "p2")?.hand).toHaveLength(0);
  });

  it("drops the undrawn deck entirely", () => {
    expect(redactedStateFor(makeState(), "p1").deck).toEqual([]);
  });

  it("keeps only the viewer's own vote from the in-progress round", () => {
    const redacted = redactedStateFor(makeState(), "p1");
    expect(redacted.votes).toEqual({ p1: true });
  });

  it("redacts the board the same way redactedBoardFor does", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Warlord", "p2", false));
    const redacted = redactedStateFor(makeState({ board }), "p1");
    expect(redacted.board.get("0,0")?.cardId).toBe("Unknown");
  });

  it("reveals the true board once the game has ended, per the endgame rule -- nothing left to hide", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Warlord", "p2", false));
    const redacted = redactedStateFor(makeState({ board, phase: "ended" }), "p1");
    expect(redacted.board.get("0,0")?.cardId).toBe("Warlord");
  });

  it("still empties other players' hands even after the game has ended", () => {
    const redacted = redactedStateFor(makeState({ phase: "ended" }), "p1");
    expect(redacted.players.find((p) => p.id === "p2")?.hand).toHaveLength(0);
  });
});
