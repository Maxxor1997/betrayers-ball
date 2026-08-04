import { describe, expect, it } from "vitest";
import { getVisibleBoard } from "../playerView";
import { Board, CardInstance, posKey } from "../types";

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
