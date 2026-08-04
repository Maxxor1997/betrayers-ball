import { describe, expect, it } from "vitest";
import { computeGameResult, isBoardFull, isRoundCapHit, shouldEndGame } from "../endgame";
import { Board, BoardBounds, CardInstance, posKey } from "../types";

const BOUNDS: BoardBounds = { width: 3, height: 3, center: { x: 1, y: 1 } };

let counter = 0;
function card(cardId: CardInstance["cardId"], ownerId: string): CardInstance {
  return { instanceId: `c${counter++}`, cardId, ownerId, faceUp: false };
}

describe("isRoundCapHit", () => {
  it("is false below the cap and true at/above it", () => {
    expect(isRoundCapHit(5, 6)).toBe(false);
    expect(isRoundCapHit(6, 6)).toBe(true);
    expect(isRoundCapHit(7, 6)).toBe(true);
  });
});

describe("isBoardFull", () => {
  it("is false on an empty board", () => {
    expect(isBoardFull(new Map(), BOUNDS)).toBe(false);
  });

  it("is true once every non-center cell is occupied", () => {
    const board: Board = new Map();
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        if (x === 1 && y === 1) continue;
        board.set(posKey({ x, y }), card("Footman", "p1"));
      }
    }
    expect(isBoardFull(board, BOUNDS)).toBe(true);
  });
});

describe("shouldEndGame", () => {
  it("triggers on cap even with an empty board", () => {
    expect(shouldEndGame(new Map(), BOUNDS, 6, 6, false)).toBe(true);
  });

  it("does not trigger below cap on a non-full board without a request", () => {
    expect(shouldEndGame(new Map(), BOUNDS, 3, 6, false)).toBe(false);
  });

  it("triggers when endRequested is true, regardless of cap/board state", () => {
    expect(shouldEndGame(new Map(), BOUNDS, 3, 6, true)).toBe(true);
  });
});

describe("computeGameResult", () => {
  it("sums owned card values and picks the highest as winner", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1")); // 5
    board.set(posKey({ x: 0, y: 1 }), card("Giant", "p2")); // 6
    const result = computeGameResult(board, BOUNDS, 3, ["p1", "p2"]);
    expect(result.scores).toEqual({ p1: 5, p2: 6 });
    expect(result.winnerIds).toEqual(["p2"]);
  });

  it("defaults a player with no cards to score 0", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1"));
    const result = computeGameResult(board, BOUNDS, 3, ["p1", "p2"]);
    expect(result.scores.p2).toBe(0);
  });

  it("shared win: ties produce multiple winnerIds", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1")); // 5
    board.set(posKey({ x: 0, y: 1 }), card("Footman", "p2")); // 5
    const result = computeGameResult(board, BOUNDS, 3, ["p1", "p2"]);
    expect(result.winnerIds.sort()).toEqual(["p1", "p2"]);
  });
});
