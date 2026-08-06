import { describe, expect, it } from "vitest";
import { resolveBoard, ResolvedCard } from "../resolution";
import { Board, BoardBounds, CardId, CardInstance, posKey } from "../types";
import { CARD_DEFS } from "@/lib/content/cards";
import { PSEUDO_CARD_BASE_VALUE } from "@/lib/content/centerEffects";

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

describe("resolveBoard — Footman row/column bonus", () => {
  it("gives +1 when its row has 3+ cards you own, even if they aren't Footmen", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Warlord", "p1");
    place(board, 2, 0, "Giant", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
  });

  it("gives +1 when its column has 3+ cards you own", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 0, 1, "Warlord", "p1");
    place(board, 0, 2, "Giant", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
  });

  it("gives no bonus for fewer than 3 owned cards in its row or column", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
  });

  it("doesn't count an opponent's cards toward the 3", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p2");
    place(board, 2, 0, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
  });

  it("cards don't need to be adjacent or contiguous -- just in the same row/column", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 4, 0, "Warlord", "p1");
    place(board, 7, 0, "Giant", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
  });
});

describe("resolveBoard — Warlord", () => {
  it("penalizes -2 per other Warlord (any owner), floored at 0", () => {
    const board: Board = new Map();
    const w1 = place(board, 0, 0, "Warlord", "p1");
    place(board, 1, 0, "Warlord", "p1");
    place(board, 2, 0, "Warlord", "p2");
    place(board, 3, 0, "Warlord", "p2");
    place(board, 4, 0, "Warlord", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    // 4 other warlords -> base - 8, which floors to 0 for this card's base
    expect(find(cards, w1.instanceId).finalValue).toBe(0);
  });

  it("is unaffected with no other Warlords", () => {
    const board: Board = new Map();
    const w1 = place(board, 0, 0, "Warlord", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, w1.instanceId).finalValue).toBe(CARD_DEFS.Warlord.base);
  });
});

describe("resolveBoard — scoring breakdown", () => {
  it("starts with a Base entry and every contribution sums to finalValue", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p1");
    place(board, 2, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = find(cards, f0.instanceId);
    expect(resolved.breakdown[0]).toEqual({ label: "Base", amount: CARD_DEFS.Footman.base });
    expect(resolved.breakdown.some((d) => d.label.includes("Footman"))).toBe(true);
    expect(resolved.breakdown.reduce((sum, d) => sum + d.amount, 0)).toBe(resolved.finalValue);
  });

  it("appends a floor adjustment entry when a card is floored at 0", () => {
    const board: Board = new Map();
    const w1 = place(board, 0, 0, "Warlord", "p1");
    place(board, 1, 0, "Warlord", "p1");
    place(board, 2, 0, "Warlord", "p2");
    place(board, 3, 0, "Warlord", "p2");
    place(board, 4, 0, "Warlord", "p2");
    place(board, 5, 0, "Warlord", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = find(cards, w1.instanceId);
    expect(resolved.finalValue).toBe(0);
    const last = resolved.breakdown[resolved.breakdown.length - 1];
    expect(last.label).toBe("Floored at 0");
    expect(resolved.breakdown.reduce((sum, d) => sum + d.amount, 0)).toBe(0);
  });

  it("appends a Kingslayer adjustment entry that still sums to finalValue", () => {
    const board: Board = new Map();
    const big = place(board, 1, 0, "Exile", "p2", true); // face-up so it's eligible
    place(board, 0, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    const resolved = find(cards, big.instanceId);
    // base - 2 (1 neighbor) - the Kingslayer pseudo-card's value
    const expected = CARD_DEFS.Exile.base - 2 - PSEUDO_CARD_BASE_VALUE;
    expect(resolved.finalValue).toBe(expected);
    const last = resolved.breakdown[resolved.breakdown.length - 1];
    expect(last.label).toBe("Kingslayer (highest face-up value)");
    expect(resolved.breakdown.reduce((sum, d) => sum + d.amount, 0)).toBe(expected);
  });
});

describe("resolveBoard — Exile", () => {
  it("loses -2 per neighbor including the center", () => {
    const board: Board = new Map();
    // adjacent to center (4,4) -> at (4,3)
    const e = place(board, 4, 3, "Exile", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, e.instanceId).finalValue).toBe(CARD_DEFS.Exile.base - 2); // 1 neighbor (center)
  });

  it("realistic ceiling is 7, never full 9, because placement forces >=1 neighbor", () => {
    const board: Board = new Map();
    const anchor = place(board, 0, 0, "Footman", "p1");
    const e = place(board, 1, 0, "Exile", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, anchor.instanceId)).toBeDefined();
    expect(find(cards, e.instanceId).finalValue).toBe(CARD_DEFS.Exile.base - 2);
  });
});

describe("resolveBoard — Pretender", () => {
  it("loses -5 if adjacent to a face-up card with base >= its own", () => {
    const board: Board = new Map();
    const p = place(board, 0, 0, "Pretender", "p1");
    place(board, 1, 0, "Exile", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, p.instanceId).finalValue).toBe(CARD_DEFS.Pretender.base - 3);
  });

  it("is safe if the dangerous neighbor is face-down", () => {
    const board: Board = new Map();
    const p = place(board, 0, 0, "Pretender", "p1");
    place(board, 1, 0, "Exile", "p2", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, p.instanceId).finalValue).toBe(CARD_DEFS.Pretender.base);
  });

  it("triggers off a neighbor whose base merely equals its own, not just a hardcoded 7", () => {
    const board: Board = new Map();
    // Two Pretenders, adjacent -- each other's base is exactly equal, not greater.
    const p1 = place(board, 0, 0, "Pretender", "p1");
    place(board, 1, 0, "Pretender", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, p1.instanceId).finalValue).toBe(CARD_DEFS.Pretender.base - 3);
  });
});

describe("resolveBoard — Berserker", () => {
  it("gains +2 per opposing-owner Berserker anywhere on the board", () => {
    const board: Board = new Map();
    const mine = place(board, 0, 0, "Berserker", "p1");
    place(board, 5, 5, "Berserker", "p2");
    place(board, 6, 6, "Berserker", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, mine.instanceId).finalValue).toBe(CARD_DEFS.Berserker.base + 2 * 2);
  });

  it("does not count same-owner copies", () => {
    const board: Board = new Map();
    const mine = place(board, 0, 0, "Berserker", "p1");
    place(board, 1, 0, "Berserker", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, mine.instanceId).finalValue).toBe(CARD_DEFS.Berserker.base);
  });
});

describe("resolveBoard — Mercenary", () => {
  it("gains +2 per adjacent card owned by a different player", () => {
    const board: Board = new Map();
    const merc = place(board, 1, 1, "Mercenary", "p1");
    place(board, 0, 1, "Footman", "p2");
    place(board, 2, 1, "Footman", "p3");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, merc.instanceId).finalValue).toBe(CARD_DEFS.Mercenary.base + 2 * 2);
  });

  it("does not count same-owner neighbors", () => {
    const board: Board = new Map();
    const merc = place(board, 1, 1, "Mercenary", "p1");
    place(board, 0, 1, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, merc.instanceId).finalValue).toBe(CARD_DEFS.Mercenary.base);
  });
});

describe("resolveBoard — Commander", () => {
  it("gains +2 per adjacent Footman (any owner)", () => {
    const board: Board = new Map();
    const cmd = place(board, 1, 1, "Commander", "p1");
    place(board, 0, 1, "Footman", "p2");
    place(board, 2, 1, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, cmd.instanceId).finalValue).toBe(CARD_DEFS.Commander.base + 2 * 2);
  });
});

describe("resolveBoard — Gloryseeker", () => {
  it("gains +3 if face-up", () => {
    const board: Board = new Map();
    const c = place(board, 0, 0, "Gloryseeker", "p1", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, c.instanceId).finalValue).toBe(CARD_DEFS.Gloryseeker.base + 3);
  });

  it("no bonus if face-down", () => {
    const board: Board = new Map();
    const c = place(board, 0, 0, "Gloryseeker", "p1", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, c.instanceId).finalValue).toBe(CARD_DEFS.Gloryseeker.base);
  });
});

describe("resolveBoard — Chronicler", () => {
  it.each([3, 4, 5, 6].map((round) => [round, CARD_DEFS.Chronicler.base + round]))(
    "round %i -> value %i",
    (round, expected) => {
      const board: Board = new Map();
      const c = place(board, 0, 0, "Chronicler", "p1");
      const { cards } = resolveBoard(board, BOUNDS, round);
      expect(find(cards, c.instanceId).finalValue).toBe(expected);
    }
  );
});

describe("resolveBoard — Earthshaker", () => {
  it("gives -1 to every other card in its row, not itself, not other rows", () => {
    const board: Board = new Map();
    const e = place(board, 1, 1, "Earthshaker", "p1");
    const sameRow1 = place(board, 0, 1, "Footman", "p2");
    const sameRow2 = place(board, 3, 1, "Footman", "p2");
    const otherRow = place(board, 1, 2, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, e.instanceId).finalValue).toBe(CARD_DEFS.Earthshaker.base);
    expect(find(cards, sameRow1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 1);
    expect(find(cards, sameRow2.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 1);
    expect(find(cards, otherRow.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
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
    expect(find(cards, above.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 3);
    expect(find(cards, below.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 3);
    expect(find(cards, side.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
    expect(find(cards, s.instanceId).finalValue).toBe(CARD_DEFS.Skysplitter.base);
  });
});

describe("resolveBoard — Bannerman", () => {
  it("gives +2 to adjacent Footmen, +1 to other adjacent cards, never itself", () => {
    const board: Board = new Map();
    const b = place(board, 1, 1, "Bannerman", "p1");
    const footman = place(board, 0, 1, "Footman", "p2");
    const other = place(board, 2, 1, "Giant", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, footman.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 2);
    expect(find(cards, other.instanceId).finalValue).toBe(CARD_DEFS.Giant.base + 1);
    expect(find(cards, b.instanceId).finalValue).toBe(CARD_DEFS.Bannerman.base);
  });
});

describe("resolveBoard — Plague Bearer", () => {
  it("steals 2 from each of 2+ same-type neighbors, gaining 2 per point stolen", () => {
    const board: Board = new Map();
    const pb = place(board, 1, 1, "PlagueBearer", "p1");
    const f1 = place(board, 0, 1, "Footman", "p2");
    const f2 = place(board, 2, 1, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 2);
    expect(find(cards, f2.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 2);
    expect(find(cards, pb.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base + 4);
  });

  it("does nothing with only 1 neighbor of a given type", () => {
    const board: Board = new Map();
    const pb = place(board, 1, 1, "PlagueBearer", "p1");
    const f1 = place(board, 0, 1, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
    expect(find(cards, pb.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base);
  });

  it("pays out multiple qualifying type-groups independently (two Footmen + two Giants)", () => {
    const board: Board = new Map();
    const pb = place(board, 2, 2, "PlagueBearer", "p1");
    const f1 = place(board, 1, 2, "Footman", "p2");
    const f2 = place(board, 3, 2, "Footman", "p2");
    const g1 = place(board, 2, 1, "Giant", "p2", true);
    const g2 = place(board, 2, 3, "Giant", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 2);
    expect(find(cards, f2.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - 2);
    expect(find(cards, g1.instanceId).finalValue).toBe(CARD_DEFS.Giant.base - 2);
    expect(find(cards, g2.instanceId).finalValue).toBe(CARD_DEFS.Giant.base - 2);
    expect(find(cards, pb.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base + 8);
  });

  it("counts another Plague Bearer as a matching neighbor type -- 'same type' includes its own", () => {
    const board: Board = new Map();
    const center = place(board, 1, 1, "PlagueBearer", "p1");
    const left = place(board, 0, 1, "PlagueBearer", "p2");
    const right = place(board, 2, 1, "PlagueBearer", "p3");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, left.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base - 2);
    expect(find(cards, right.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base - 2);
    expect(find(cards, center.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base + 4);
  });
});

describe("resolveBoard — Infiltrator", () => {
  it("face-up: neutralized, scores its own base with no swap even next to a much bigger card", () => {
    const board: Board = new Map();
    const inf = place(board, 1, 1, "Infiltrator", "p1", true);
    const warlord = place(board, 0, 1, "Warlord", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, inf.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
    expect(find(cards, warlord.instanceId).finalValue).toBe(CARD_DEFS.Warlord.base);
  });

  it("face-down: swaps base with the highest-base adjacent card", () => {
    const board: Board = new Map();
    // Warlord carries no self-modifying effect here (no other Warlords on the board),
    // so its finalValue is just its base -- a clean comparison.
    const inf = place(board, 1, 1, "Infiltrator", "p1", false);
    const warlord = place(board, 0, 1, "Warlord", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, inf.instanceId).finalValue).toBe(CARD_DEFS.Warlord.base);
    expect(find(cards, warlord.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
  });

  it("swap applies even if the neighbor is face-down -- resolution sees true identity", () => {
    const board: Board = new Map();
    const inf = place(board, 1, 1, "Infiltrator", "p1", false);
    const warlord = place(board, 0, 1, "Warlord", "p2", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, inf.instanceId).finalValue).toBe(CARD_DEFS.Warlord.base);
    expect(find(cards, warlord.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
  });

  it("still swaps even when the only neighbor has a lower base -- a real downside, not just upside", () => {
    const board: Board = new Map();
    const inf = place(board, 1, 1, "Infiltrator", "p1", false);
    const commander = place(board, 0, 1, "Commander", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, inf.instanceId).finalValue).toBe(CARD_DEFS.Commander.base);
    expect(find(cards, commander.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
  });

  it("picks only the single highest-base neighbor among several", () => {
    const board: Board = new Map();
    // Warlord and Giant carry no self-modifying effect here (no other Warlords on the
    // board), so their finalValue is just their base -- a clean comparison.
    const inf = place(board, 1, 1, "Infiltrator", "p1", false);
    const warlord = place(board, 0, 1, "Warlord", "p2"); // base 8, the highest
    const giant = place(board, 2, 1, "Giant", "p2"); // base 6
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, inf.instanceId).finalValue).toBe(CARD_DEFS.Warlord.base);
    expect(find(cards, warlord.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
    // The lower-base neighbor is untouched -- only the highest is swapped with.
    expect(find(cards, giant.instanceId).finalValue).toBe(CARD_DEFS.Giant.base);
  });

  it("no-op when there's no neighbor to swap with", () => {
    const board: Board = new Map();
    const inf = place(board, 1, 1, "Infiltrator", "p1", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, inf.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
  });

  it("no-op when the highest-base neighbor's base equals its own", () => {
    const board: Board = new Map();
    const a = place(board, 1, 1, "Infiltrator", "p1", false);
    const b = place(board, 0, 1, "Infiltrator", "p2", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, a.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
    expect(find(cards, b.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
  });

  it("flipping it face-up is the counter -- neutralizes an in-progress swap", () => {
    const board: Board = new Map();
    const inf = place(board, 1, 1, "Infiltrator", "p1", true); // flipped, neutralized
    const warlord = place(board, 0, 1, "Warlord", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, inf.instanceId).finalValue).toBe(CARD_DEFS.Infiltrator.base);
    expect(find(cards, warlord.instanceId).finalValue).toBe(CARD_DEFS.Warlord.base);
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
    // No +2 from Bannerman (negated) -- but Footman's own row bonus still fires,
    // since negation cancels a card's own/outgoing effects, not its ownership as read
    // by others: row y=2 has 3 p2-owned cards (Giant, Bannerman, Footman itself).
    expect(find(cards, footman.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
  });

  it("without an active Suppressor, Bannerman's buff lands normally", () => {
    const board: Board = new Map();
    place(board, 3, 2, "Bannerman", "p2");
    const footman = place(board, 4, 2, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, footman.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 2);
  });

  it("a negated card still counts toward its owner's row/column total for others, but scores no bonus itself", () => {
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
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base); // negated, no own +1
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1); // still sees 3 p1-owned in row y=0
    expect(find(cards, f2.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
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
    // No steal from the negated Plague Bearer -- but f1's own row bonus still fires:
    // row y=2 has 3 p2-owned cards (Giant, Plague Bearer, f1 itself).
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
    expect(find(cards, f2.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
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
    expect(totalsByOwner.p1).toBe(3 * (CARD_DEFS.Footman.base + 1)); // 3 footmen, each with the line bonus
    expect(totalsByOwner.p2).toBe(CARD_DEFS.Giant.base);
  });
});

describe("resolveBoard — center effect: Shadowlands", () => {
  it("gives +1 to face-down cards; face-up cards are untouched", () => {
    const board: Board = new Map();
    const hidden = place(board, 0, 0, "Footman", "p1", false);
    const shown = place(board, 5, 5, "Footman", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3, "shadowlands");
    expect(find(cards, hidden.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
    expect(find(cards, shown.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
  });

  it("does not apply when a different center effect (or none) is active", () => {
    const board: Board = new Map();
    const hidden = place(board, 0, 0, "Footman", "p1", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, hidden.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
  });
});

describe("resolveBoard — center effect: Mirror Pool", () => {
  it("gives +2 each when the mirrored cell holds the same card type", () => {
    const board: Board = new Map();
    // center (4,4); mirror of (2,2) is (2, 8-2=6)
    const a = place(board, 2, 2, "Footman", "p1");
    const b = place(board, 2, 6, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 2);
    expect(find(cards, b.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 2);
  });

  it("gives +1 each when the mirrored cell holds a different card type", () => {
    const board: Board = new Map();
    const a = place(board, 2, 2, "Footman", "p1");
    const b = place(board, 2, 6, "Giant", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
    expect(find(cards, b.instanceId).finalValue).toBe(CARD_DEFS.Giant.base + 1);
  });

  it("gives no bonus when the mirror cell is empty", () => {
    const board: Board = new Map();
    const a = place(board, 2, 2, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
  });

  it("a card exactly on the center row has no distinct mirror", () => {
    const board: Board = new Map();
    const a = place(board, 0, 4, "Footman", "p1"); // center row, mirrors onto itself
    const { cards } = resolveBoard(board, BOUNDS, 3, "mirrorPool");
    expect(find(cards, a.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
  });
});

describe("resolveBoard — center effect: Champion of the Weak", () => {
  it("transfers the center's value to the owner of the single lowest-valued card", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p1"); // p1's cards are all Footman-base
    place(board, 5, 5, "Berserker", "p2"); // no rival Berserker -- unique lowest card on the board
    const { totalsByOwner, centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward).toEqual({ value: PSEUDO_CARD_BASE_VALUE, ownerId: "p2" });
    expect(totalsByOwner.p2).toBe(CARD_DEFS.Berserker.base + PSEUDO_CARD_BASE_VALUE);
  });

  it("makes no transfer on a tie for the lowest card value", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p2");
    const { totalsByOwner, centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward).toBeNull();
    expect(totalsByOwner.p1).toBe(CARD_DEFS.Footman.base);
    expect(totalsByOwner.p2).toBe(CARD_DEFS.Footman.base);
  });

  it("a player with zero cards has no card to compare, so can't win", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    const { totalsByOwner, centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward).toEqual({ value: PSEUDO_CARD_BASE_VALUE, ownerId: "p1" });
    expect(totalsByOwner.p1).toBe(CARD_DEFS.Footman.base + PSEUDO_CARD_BASE_VALUE);
  });

  it("center value is modified by adjacent Bannerman/Earthshaker/Skysplitter", () => {
    const board: Board = new Map();
    // Bannerman directly adjacent to center (4,4) -> +1 (center is never a Footman)
    place(board, 4, 3, "Bannerman", "p2");
    place(board, 0, 0, "Footman", "p1");
    const { centerAward } = resolveBoard(board, BOUNDS, 3, "championOfTheWeak", ["p1", "p2"]);
    expect(centerAward?.value).toBe(PSEUDO_CARD_BASE_VALUE + 1);
  });
});

describe("resolveBoard — center effect: Kingslayer", () => {
  it("subtracts its value from the single highest-value face-up card and adjusts totals", () => {
    const board: Board = new Map();
    const small = place(board, 0, 0, "Footman", "p1", true);
    const big = place(board, 1, 0, "Exile", "p2", true); // -2 for its 1 neighbor
    const { cards, totalsByOwner } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    const bigExpected = CARD_DEFS.Exile.base - 2 - PSEUDO_CARD_BASE_VALUE;
    expect(find(cards, big.instanceId).finalValue).toBe(bigExpected);
    expect(find(cards, small.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
    expect(totalsByOwner.p2).toBe(bigExpected);
    expect(totalsByOwner.p1).toBe(CARD_DEFS.Footman.base);
  });

  it("hits all tied-for-highest face-up cards", () => {
    const board: Board = new Map();
    const a = place(board, 0, 0, "Footman", "p1", true);
    const b = place(board, 5, 5, "Footman", "p2", true);
    const { cards, totalsByOwner } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    const expected = CARD_DEFS.Footman.base - PSEUDO_CARD_BASE_VALUE;
    expect(find(cards, a.instanceId).finalValue).toBe(expected);
    expect(find(cards, b.instanceId).finalValue).toBe(expected);
    expect(totalsByOwner.p1).toBe(expected);
    expect(totalsByOwner.p2).toBe(expected);
  });

  it("ignores face-down cards even if they'd otherwise be the highest value", () => {
    const board: Board = new Map();
    const hidden = place(board, 0, 0, "Exile", "p1", false);
    const shown = place(board, 5, 5, "Footman", "p2", true); // only face-up card
    const { cards, totalsByOwner } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    const shownExpected = CARD_DEFS.Footman.base - PSEUDO_CARD_BASE_VALUE;
    expect(find(cards, hidden.instanceId).finalValue).toBe(CARD_DEFS.Exile.base); // untouched
    expect(find(cards, shown.instanceId).finalValue).toBe(shownExpected); // hit as the only eligible card
    expect(totalsByOwner.p1).toBe(CARD_DEFS.Exile.base);
    expect(totalsByOwner.p2).toBe(shownExpected);
  });

  it("makes no adjustment when no card is face-up", () => {
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1", false);
    const { totalsByOwner } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    expect(totalsByOwner.p1).toBe(CARD_DEFS.Footman.base);
  });

  it("Kingslayer's own value is modified by adjacent Bannerman/Earthshaker/Skysplitter, same as the center", () => {
    const board: Board = new Map();
    place(board, 4, 3, "Bannerman", "p1", true); // adjacent to center (4,4) -> +1
    const shown = place(board, 0, 0, "Footman", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3, "kingslayer");
    // Footman is the unique highest face-up card, so it's the target -- its
    // subtraction should reflect Kingslayer's Bannerman-boosted value, not the
    // unmodified PSEUDO_CARD_BASE_VALUE.
    expect(find(cards, shown.instanceId).finalValue).toBe(CARD_DEFS.Footman.base - (PSEUDO_CARD_BASE_VALUE + 1));
  });
});
