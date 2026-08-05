import { describe, expect, it } from "vitest";
import { resolveBoard, ResolvedCard } from "../resolution";
import { Board, BoardBounds, CardId, CardInstance, posKey } from "../types";

const BOUNDS: BoardBounds = { width: 9, height: 9, center: { x: 4, y: 4 } };

let counter = 0;
function place(board: Board, x: number, y: number, cardId: CardId, ownerId: string, faceUp = false): CardInstance {
  const c: CardInstance = { instanceId: `c${counter++}`, cardId, ownerId, faceUp };
  board.set(posKey({ x, y }), c);
  return c;
}

function find(cards: ResolvedCard[], instanceId: string): ResolvedCard {
  const found = cards.find((c) => c.instanceId === instanceId);
  if (!found) throw new Error(`not found: ${instanceId}`);
  return found;
}

describe("resolveBoard — Footman line bonus", () => {
  it("gives +1 to each Footman in a 3+ same-owner line", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    const f1 = place(board, 1, 0, "Footman", "p1");
    const f2 = place(board, 2, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(6);
    expect(find(cards, f1.instanceId).finalValue).toBe(6);
    expect(find(cards, f2.instanceId).finalValue).toBe(6);
  });

  it("gives no bonus for fewer than 3", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(5);
  });
});

describe("resolveBoard — Warlord", () => {
  it("penalizes -3 per other Warlord (any owner), floored at 0", () => {
    const board: Board = new Map();
    const w1 = place(board, 0, 0, "Warlord", "p1");
    place(board, 1, 0, "Warlord", "p1");
    place(board, 2, 0, "Warlord", "p2");
    place(board, 3, 0, "Warlord", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    // base 8, 3 other warlords -> 8 - 9 = -1 -> floored to 0
    expect(find(cards, w1.instanceId).finalValue).toBe(0);
  });

  it("is unaffected with no other Warlords", () => {
    const board: Board = new Map();
    const w1 = place(board, 0, 0, "Warlord", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, w1.instanceId).finalValue).toBe(8);
  });
});

describe("resolveBoard — Exile", () => {
  it("loses -2 per neighbor including the center", () => {
    const board: Board = new Map();
    // adjacent to center (4,4) -> at (4,3)
    const e = place(board, 4, 3, "Exile", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, e.instanceId).finalValue).toBe(7); // 9 - 2*1 (center)
  });

  it("realistic ceiling is 7, never full 9, because placement forces >=1 neighbor", () => {
    const board: Board = new Map();
    const anchor = place(board, 0, 0, "Footman", "p1");
    const e = place(board, 1, 0, "Exile", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, anchor.instanceId)).toBeDefined();
    expect(find(cards, e.instanceId).finalValue).toBe(7);
  });
});

describe("resolveBoard — Pretender", () => {
  it("loses -5 if adjacent to a face-up base>=7 card", () => {
    const board: Board = new Map();
    const p = place(board, 0, 0, "Pretender", "p1");
    place(board, 1, 0, "Exile", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, p.instanceId).finalValue).toBe(2);
  });

  it("is safe if the dangerous neighbor is face-down", () => {
    const board: Board = new Map();
    const p = place(board, 0, 0, "Pretender", "p1");
    place(board, 1, 0, "Exile", "p2", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, p.instanceId).finalValue).toBe(7);
  });
});

describe("resolveBoard — Berserker", () => {
  it("gains +2 per opposing-owner Berserker anywhere on the board", () => {
    const board: Board = new Map();
    const mine = place(board, 0, 0, "Berserker", "p1");
    place(board, 5, 5, "Berserker", "p2");
    place(board, 6, 6, "Berserker", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, mine.instanceId).finalValue).toBe(7); // 3 + 2*2
  });

  it("does not count same-owner copies", () => {
    const board: Board = new Map();
    const mine = place(board, 0, 0, "Berserker", "p1");
    place(board, 1, 0, "Berserker", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, mine.instanceId).finalValue).toBe(3);
  });
});

describe("resolveBoard — Mercenary", () => {
  it("gains +2 per adjacent card owned by a different player", () => {
    const board: Board = new Map();
    const merc = place(board, 1, 1, "Mercenary", "p1");
    place(board, 0, 1, "Footman", "p2");
    place(board, 2, 1, "Footman", "p3");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, merc.instanceId).finalValue).toBe(6); // 2 + 2*2
  });

  it("does not count same-owner neighbors", () => {
    const board: Board = new Map();
    const merc = place(board, 1, 1, "Mercenary", "p1");
    place(board, 0, 1, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, merc.instanceId).finalValue).toBe(2);
  });
});

describe("resolveBoard — Commander", () => {
  it("gains +2 per adjacent Footman (any owner)", () => {
    const board: Board = new Map();
    const cmd = place(board, 1, 1, "Commander", "p1");
    place(board, 0, 1, "Footman", "p2");
    place(board, 2, 1, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, cmd.instanceId).finalValue).toBe(6); // 2 + 2*2
  });
});

describe("resolveBoard — Champion", () => {
  it("gains +3 if face-up", () => {
    const board: Board = new Map();
    const c = place(board, 0, 0, "Champion", "p1", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, c.instanceId).finalValue).toBe(7);
  });

  it("no bonus if face-down", () => {
    const board: Board = new Map();
    const c = place(board, 0, 0, "Champion", "p1", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, c.instanceId).finalValue).toBe(4);
  });
});

describe("resolveBoard — Darkspawn", () => {
  it("gains +5 with 2+ adjacent face-down cards", () => {
    const board: Board = new Map();
    const d = place(board, 1, 1, "Darkspawn", "p1");
    place(board, 0, 1, "Footman", "p2", false);
    place(board, 2, 1, "Footman", "p2", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, d.instanceId).finalValue).toBe(7);
  });

  it("no bonus with only 1 adjacent face-down card", () => {
    const board: Board = new Map();
    const d = place(board, 1, 1, "Darkspawn", "p1");
    place(board, 0, 1, "Footman", "p2", false);
    place(board, 2, 1, "Footman", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, d.instanceId).finalValue).toBe(2);
  });
});

describe("resolveBoard — Chronicler", () => {
  it.each([
    [3, 5],
    [4, 6],
    [5, 7],
    [6, 8],
  ])("round %i -> value %i", (round, expected) => {
    const board: Board = new Map();
    const c = place(board, 0, 0, "Chronicler", "p1");
    const { cards } = resolveBoard(board, BOUNDS, round);
    expect(find(cards, c.instanceId).finalValue).toBe(expected);
  });
});

describe("resolveBoard — Earthshaker", () => {
  it("gives -1 to every other card in its row, not itself, not other rows", () => {
    const board: Board = new Map();
    const e = place(board, 1, 1, "Earthshaker", "p1");
    const sameRow1 = place(board, 0, 1, "Footman", "p2");
    const sameRow2 = place(board, 3, 1, "Footman", "p2");
    const otherRow = place(board, 1, 2, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, e.instanceId).finalValue).toBe(3);
    expect(find(cards, sameRow1.instanceId).finalValue).toBe(4);
    expect(find(cards, sameRow2.instanceId).finalValue).toBe(4);
    expect(find(cards, otherRow.instanceId).finalValue).toBe(5);
  });
});

describe("resolveBoard — Skysplitter", () => {
  it("gives -3 to the card above and below, not left/right", () => {
    const board: Board = new Map();
    const s = place(board, 1, 1, "Skysplitter", "p1");
    const above = place(board, 1, 0, "Footman", "p2");
    const below = place(board, 1, 2, "Footman", "p2");
    const side = place(board, 0, 1, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, above.instanceId).finalValue).toBe(2);
    expect(find(cards, below.instanceId).finalValue).toBe(2);
    expect(find(cards, side.instanceId).finalValue).toBe(5);
    expect(find(cards, s.instanceId).finalValue).toBe(3);
  });
});

describe("resolveBoard — Bannerman", () => {
  it("gives +2 to adjacent Footmen, +1 to other adjacent cards, never itself", () => {
    const board: Board = new Map();
    const b = place(board, 1, 1, "Bannerman", "p1");
    const footman = place(board, 0, 1, "Footman", "p2");
    const other = place(board, 2, 1, "Giant", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, footman.instanceId).finalValue).toBe(7);
    expect(find(cards, other.instanceId).finalValue).toBe(7);
    expect(find(cards, b.instanceId).finalValue).toBe(4);
  });
});

describe("resolveBoard — Plague Bearer zeroing", () => {
  it("zeroes 2+ adjacent Footmen but keeps its own base", () => {
    const board: Board = new Map();
    const pb = place(board, 1, 1, "PlagueBearer", "p1");
    const f1 = place(board, 0, 1, "Footman", "p2");
    const f2 = place(board, 2, 1, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(0);
    expect(find(cards, f2.instanceId).finalValue).toBe(0);
    expect(find(cards, pb.instanceId).finalValue).toBe(3);
  });

  it("does nothing with only 1 adjacent Footman", () => {
    const board: Board = new Map();
    place(board, 1, 1, "PlagueBearer", "p1");
    const f1 = place(board, 0, 1, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(5);
  });

  it("overrides other bonuses (e.g. a Footman line) down to 0", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    const f1 = place(board, 1, 0, "Footman", "p1");
    const f2 = place(board, 2, 0, "Footman", "p1");
    const pb = place(board, 1, 1, "PlagueBearer", "p2");
    // pb is adjacent to f1 only (1 footman) -- add another footman neighbor to trigger
    const f3 = place(board, 2, 1, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(0);
    expect(find(cards, f3.instanceId).finalValue).toBe(0);
    // f0 and f2 are not adjacent to the Plague Bearer, so their line bonus stands.
    expect(find(cards, f0.instanceId).finalValue).toBe(6);
    expect(find(cards, pb.instanceId).finalValue).toBe(3);
  });
});

describe("resolveBoard — Headsman", () => {
  it("gives -4 to adjacent face-up cards with base >= 6", () => {
    const board: Board = new Map();
    const h = place(board, 1, 1, "Headsman", "p1");
    const giant = place(board, 0, 1, "Giant", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, giant.instanceId).finalValue).toBe(2);
  });

  it("does not affect face-down big cards or low-base cards", () => {
    const board: Board = new Map();
    place(board, 1, 1, "Headsman", "p1");
    const hiddenGiant = place(board, 0, 1, "Giant", "p2", false);
    const footman = place(board, 2, 1, "Footman", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, hiddenGiant.instanceId).finalValue).toBe(6);
    expect(find(cards, footman.instanceId).finalValue).toBe(5);
  });
});

describe("resolveBoard — Suppressor & resolution ordering", () => {
  it("an active Suppressor negates adjacent non-Suppressor cards", () => {
    const board: Board = new Map();
    const s = place(board, 2, 2, "Suppressor", "p1");
    const ban = place(board, 3, 2, "Bannerman", "p2");
    place(board, 1, 2, "Giant", "p2");
    place(board, 2, 1, "Giant", "p2");
    place(board, 2, 3, "Giant", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, ban.instanceId).negated).toBe(true);
    expect(find(cards, s.instanceId).negated).toBe(false);
  });

  it("suppression runs before the value-modifying pass: a negated Bannerman's outgoing buff doesn't land", () => {
    const board: Board = new Map();
    place(board, 2, 2, "Suppressor", "p1");
    place(board, 3, 2, "Bannerman", "p2");
    place(board, 1, 2, "Giant", "p2");
    place(board, 2, 1, "Giant", "p2");
    place(board, 2, 3, "Giant", "p2");
    const footman = place(board, 4, 2, "Footman", "p2"); // adjacent to Bannerman only
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, footman.instanceId).finalValue).toBe(5); // no +2, Bannerman is negated
  });

  it("without an active Suppressor, Bannerman's buff lands normally", () => {
    const board: Board = new Map();
    place(board, 3, 2, "Bannerman", "p2");
    const footman = place(board, 4, 2, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, footman.instanceId).finalValue).toBe(7);
  });

  it("a negated Footman still counts as a line-link for its neighbors, but gets no bonus itself", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    const f1 = place(board, 1, 0, "Footman", "p1"); // will be negated
    const f2 = place(board, 2, 0, "Footman", "p1");
    place(board, 1, 1, "Suppressor", "p2");
    place(board, 1, 2, "Giant", "p2");
    place(board, 0, 1, "Giant", "p2");
    place(board, 2, 1, "Giant", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).negated).toBe(true);
    expect(find(cards, f1.instanceId).finalValue).toBe(5); // negated, no own +1
    expect(find(cards, f0.instanceId).finalValue).toBe(6); // still sees a 3-line via f1
    expect(find(cards, f2.instanceId).finalValue).toBe(6);
  });

  it("two adjacent Suppressors never negate each other", () => {
    const board: Board = new Map();
    const a = place(board, 2, 2, "Suppressor", "p1");
    const b = place(board, 3, 2, "Suppressor", "p1");
    place(board, 1, 2, "Giant", "p2");
    place(board, 2, 1, "Giant", "p2");
    place(board, 2, 3, "Giant", "p2");
    place(board, 4, 2, "Giant", "p2");
    place(board, 3, 1, "Giant", "p2");
    place(board, 3, 3, "Giant", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, a.instanceId).negated).toBe(false);
    expect(find(cards, b.instanceId).negated).toBe(false);
  });

  it("a negated Plague Bearer does nothing", () => {
    const board: Board = new Map();
    place(board, 2, 2, "Suppressor", "p1");
    const pb = place(board, 3, 2, "PlagueBearer", "p2");
    place(board, 1, 2, "Giant", "p2");
    place(board, 2, 1, "Giant", "p2");
    place(board, 2, 3, "Giant", "p2");
    const f1 = place(board, 4, 2, "Footman", "p2");
    const f2 = place(board, 3, 1, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, pb.instanceId).negated).toBe(true);
    expect(find(cards, f1.instanceId).finalValue).toBe(5);
    expect(find(cards, f2.instanceId).finalValue).toBe(5);
  });
});

describe("resolveBoard — totals", () => {
  it("totalsByOwner sums each owner's frozen card values", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p1");
    place(board, 2, 0, "Footman", "p1");
    place(board, 0, 1, "Giant", "p2");
    const { totalsByOwner } = resolveBoard(board, BOUNDS, 3);
    expect(totalsByOwner.p1).toBe(18); // 3 footmen at 6 each (line bonus)
    expect(totalsByOwner.p2).toBe(6);
  });
});

describe("resolveBoard — center effect: No Man's Land", () => {
  it("gives -2 to cards on the center's row or column, center exempt", () => {
    const board: Board = new Map();
    const onRow = place(board, 0, 4, "Footman", "p1"); // same row as center (4,4)
    const onCol = place(board, 4, 0, "Footman", "p1"); // same column as center
    const offCross = place(board, 0, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3, "noMansLand");
    expect(find(cards, onRow.instanceId).finalValue).toBe(3);
    expect(find(cards, onCol.instanceId).finalValue).toBe(3);
    expect(find(cards, offCross.instanceId).finalValue).toBe(5);
  });

  it("does not apply when a different center effect (or none) is active", () => {
    const board: Board = new Map();
    const onRow = place(board, 0, 4, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, onRow.instanceId).finalValue).toBe(5);
  });
});

describe("resolveBoard — center effect: Mirror Pool", () => {
  it("gives +2 each when the mirrored cell holds the same card type", () => {
    const board: Board = new Map();
    // center (4,4); mirror of (2,2) is (2, 8-2=6)
    const a = place(board, 2, 2, "Footman", "p1");
    const b = place(board, 2, 6, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(7);
    expect(find(cards, b.instanceId).finalValue).toBe(7);
  });

  it("gives +1 each when the mirrored cell holds a different card type", () => {
    const board: Board = new Map();
    const a = place(board, 2, 2, "Footman", "p1");
    const b = place(board, 2, 6, "Giant", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(6);
    expect(find(cards, b.instanceId).finalValue).toBe(7);
  });

  it("gives no bonus when the mirror cell is empty", () => {
    const board: Board = new Map();
    const a = place(board, 2, 2, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(5);
  });

  it("a card exactly on the center row has no distinct mirror", () => {
    const board: Board = new Map();
    const a = place(board, 0, 4, "Footman", "p1"); // center row, mirrors onto itself
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(5);
  });
});

describe("resolveBoard — center effect: Champion of the Weak", () => {
  it("transfers the center's value to the unique last-place player", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1"); // p1 total 5
    place(board, 1, 0, "Footman", "p2"); // p2 total 5... make p2 strictly higher
    place(board, 2, 0, "Footman", "p2"); // p2 total 10
    const { totalsByOwner, centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward).toEqual({ value: 5, ownerId: "p1" });
    expect(totalsByOwner.p1).toBe(10); // 5 (own card) + 5 (center)
  });

  it("makes no transfer on a tie for last place", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p2");
    const { totalsByOwner, centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward).toBeNull();
    expect(totalsByOwner.p1).toBe(5);
    expect(totalsByOwner.p2).toBe(5);
  });

  it("a player with zero cards is eligible as the unique last place", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    const { totalsByOwner, centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward).toEqual({ value: 5, ownerId: "p2" });
    expect(totalsByOwner.p2).toBe(5);
  });

  it("center value is modified by adjacent Bannerman/Earthshaker/Skysplitter", () => {
    const board: Board = new Map();
    // Bannerman directly adjacent to center (4,4) -> +1 (center is never a Footman)
    place(board, 4, 3, "Bannerman", "p2");
    place(board, 0, 0, "Footman", "p1");
    const { centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward?.value).toBe(6);
  });
});

describe("resolveBoard — center effect: Kingslayer", () => {
  it("zeroes the single highest-value card and adjusts totals", () => {
    const board: Board = new Map();
    const small = place(board, 0, 0, "Footman", "p1"); // 5
    const big = place(board, 1, 0, "Exile", "p2"); // 9 - 2*1 neighbor = 7
    const { cards, totalsByOwner } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    expect(find(cards, big.instanceId).finalValue).toBe(0);
    expect(find(cards, small.instanceId).finalValue).toBe(5);
    expect(totalsByOwner.p2).toBe(0);
    expect(totalsByOwner.p1).toBe(5);
  });

  it("zeroes all tied-for-highest cards", () => {
    const board: Board = new Map();
    const a = place(board, 0, 0, "Footman", "p1");
    const b = place(board, 5, 5, "Footman", "p2");
    const { cards, totalsByOwner } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    expect(find(cards, a.instanceId).finalValue).toBe(0);
    expect(find(cards, b.instanceId).finalValue).toBe(0);
    expect(totalsByOwner.p1).toBe(0);
    expect(totalsByOwner.p2).toBe(0);
  });
});
