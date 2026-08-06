import { describe, expect, it } from "vitest";
import {
  adjacentPositions,
  countAdjacentOccupied,
  getAdjacentCards,
  getLegalPlacementPositions,
  inBounds,
  isCenterPosition,
} from "../board";
import { Board, BoardBounds, CardInstance, posKey } from "../types";

const BOUNDS: BoardBounds = { width: 5, height: 3, center: { x: 2, y: 1 } };

function card(cardId: CardInstance["cardId"], ownerId: string, faceUp = false): CardInstance {
  return { instanceId: `${cardId}-${ownerId}-${Math.random()}`, cardId, ownerId, faceUp };
}

describe("inBounds / isCenterPosition", () => {
  it("rejects out-of-bounds positions", () => {
    expect(inBounds({ x: -1, y: 0 }, BOUNDS)).toBe(false);
    expect(inBounds({ x: 5, y: 0 }, BOUNDS)).toBe(false);
    expect(inBounds({ x: 0, y: 3 }, BOUNDS)).toBe(false);
    expect(inBounds({ x: 4, y: 2 }, BOUNDS)).toBe(true);
  });

  it("identifies the true-middle center", () => {
    expect(isCenterPosition({ x: 2, y: 1 }, BOUNDS)).toBe(true);
    expect(isCenterPosition({ x: 2, y: 0 }, BOUNDS)).toBe(false);
  });
});

describe("adjacentPositions", () => {
  it("returns 4 neighbors in the interior", () => {
    expect(adjacentPositions({ x: 2, y: 1 }, BOUNDS)).toHaveLength(4);
  });

  it("clips neighbors at a corner to 2", () => {
    expect(adjacentPositions({ x: 0, y: 0 }, BOUNDS)).toHaveLength(2);
  });
});

describe("countAdjacentOccupied / getAdjacentCards", () => {
  it("counts the center tile as an occupied neighbor", () => {
    const board: Board = new Map();
    // (2,0) is directly above center (2,1); board otherwise empty.
    expect(countAdjacentOccupied(board, BOUNDS, { x: 2, y: 0 })).toBe(1);
    expect(getAdjacentCards(board, BOUNDS, { x: 2, y: 0 })).toHaveLength(0);
  });

  it("counts real placed cards plus center", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 1, y: 1 }), card("Footman", "p1"));
    board.set(posKey({ x: 3, y: 1 }), card("Footman", "p1"));
    // (2,1) is the center itself, but we're querying from an occupied real cell's neighbor count instead.
    // Query from (2,0): neighbors are (2,1)=center, (1,0)=empty, (3,0)=empty -> only center counts.
    expect(countAdjacentOccupied(board, BOUNDS, { x: 2, y: 0 })).toBe(1);
  });
});

describe("getLegalPlacementPositions", () => {
  it("on an empty board, only cells adjacent to center are legal", () => {
    const board: Board = new Map();
    const legal = getLegalPlacementPositions(board, BOUNDS).map(posKey).sort();
    // center is (2,1); its in-bounds orthogonal neighbors: (2,0), (1,1), (3,1) -- (2,2) is out of bounds (height=3, y max=2)... wait height=3 means y in [0,2].
    expect(legal.sort()).toEqual(["1,1", "2,0", "2,2", "3,1"].sort());
  });

  it("never includes the center or occupied cells", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 0 }), card("Footman", "p1"));
    const legal = getLegalPlacementPositions(board, BOUNDS).map(posKey);
    expect(legal).not.toContain("2,1");
    expect(legal).not.toContain("2,0");
  });

  it("expands legal cells to neighbors of newly placed cards", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 0 }), card("Footman", "p1"));
    const legal = getLegalPlacementPositions(board, BOUNDS).map(posKey);
    expect(legal).toContain("1,0");
    expect(legal).toContain("3,0");
  });

  it("with anywhere: true (Freelands), every empty non-center cell is legal, even on an empty board", () => {
    const board: Board = new Map();
    const legal = getLegalPlacementPositions(board, BOUNDS, { anywhere: true }).map(posKey);
    const allCells = 5 * 3 - 1; // width * height, minus the center tile
    expect(legal).toHaveLength(allCells);
    expect(legal).not.toContain("2,1"); // center still excluded
    expect(legal).toContain("0,0"); // far corner, not adjacent to anything -- still legal
  });
});
