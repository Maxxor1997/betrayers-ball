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

describe("resolveBoard — Footman line bonus", () => {
  it("gives +1 to each Footman in a 3+ same-owner line", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    const f1 = place(board, 1, 0, "Footman", "p1");
    const f2 = place(board, 2, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
    expect(find(cards, f2.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
  });

  it("gives no bonus for fewer than 3", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
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
    // 3 other warlords -> base - 9, which floors to 0 for this card's base
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
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = find(cards, w1.instanceId);
    expect(resolved.finalValue).toBe(0);
    const last = resolved.breakdown[resolved.breakdown.length - 1];
    expect(last.label).toBe("Floored at 0");
    expect(resolved.breakdown.reduce((sum, d) => sum + d.amount, 0)).toBe(0);
  });

  it("appends a zeroed-by-PlagueBearer entry", () => {
    const board: Board = new Map();
    const footman = place(board, 0, 1, "Footman", "p1");
    place(board, 2, 1, "Footman", "p1");
    place(board, 1, 1, "PlagueBearer", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = find(cards, footman.instanceId);
    expect(resolved.finalValue).toBe(0);
    const last = resolved.breakdown[resolved.breakdown.length - 1];
    expect(last.label).toBe("Zeroed by Plague Bearer");
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
  it("loses -5 if adjacent to a face-up base>=7 card", () => {
    const board: Board = new Map();
    const p = place(board, 0, 0, "Pretender", "p1");
    place(board, 1, 0, "Exile", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, p.instanceId).finalValue).toBe(CARD_DEFS.Pretender.base - 5);
  });

  it("is safe if the dangerous neighbor is face-down", () => {
    const board: Board = new Map();
    const p = place(board, 0, 0, "Pretender", "p1");
    place(board, 1, 0, "Exile", "p2", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, p.instanceId).finalValue).toBe(CARD_DEFS.Pretender.base);
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

describe("resolveBoard — Darkspawn", () => {
  it("gains +5 with 2+ adjacent face-down cards", () => {
    const board: Board = new Map();
    const d = place(board, 1, 1, "Darkspawn", "p1");
    place(board, 0, 1, "Footman", "p2", false);
    place(board, 2, 1, "Footman", "p2", false);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, d.instanceId).finalValue).toBe(CARD_DEFS.Darkspawn.base + 5);
  });

  it("no bonus with only 1 adjacent face-down card", () => {
    const board: Board = new Map();
    const d = place(board, 1, 1, "Darkspawn", "p1");
    place(board, 0, 1, "Footman", "p2", false);
    place(board, 2, 1, "Footman", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, d.instanceId).finalValue).toBe(CARD_DEFS.Darkspawn.base);
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

describe("resolveBoard — Plague Bearer zeroing", () => {
  it("zeroes 2+ adjacent Footmen but keeps its own base", () => {
    const board: Board = new Map();
    const pb = place(board, 1, 1, "PlagueBearer", "p1");
    const f1 = place(board, 0, 1, "Footman", "p2");
    const f2 = place(board, 2, 1, "Footman", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(0);
    expect(find(cards, f2.instanceId).finalValue).toBe(0);
    expect(find(cards, pb.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base);
  });

  it("does nothing with only 1 adjacent Footman", () => {
    const board: Board = new Map();
    place(board, 1, 1, "PlagueBearer", "p1");
    const f1 = place(board, 0, 1, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
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
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1);
    expect(find(cards, pb.instanceId).finalValue).toBe(CARD_DEFS.PlagueBearer.base);
  });
});

describe("resolveBoard — Headsman", () => {
  it("gives -4 to adjacent face-up cards with base >= 6", () => {
    const board: Board = new Map();
    const h = place(board, 1, 1, "Headsman", "p1");
    const giant = place(board, 0, 1, "Giant", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, giant.instanceId).finalValue).toBe(CARD_DEFS.Giant.base - 4);
  });

  it("does not affect face-down big cards or low-base cards", () => {
    const board: Board = new Map();
    place(board, 1, 1, "Headsman", "p1");
    const hiddenGiant = place(board, 0, 1, "Giant", "p2", false);
    const footman = place(board, 2, 1, "Footman", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, hiddenGiant.instanceId).finalValue).toBe(CARD_DEFS.Giant.base);
    expect(find(cards, footman.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
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
    expect(find(cards, footman.instanceId).finalValue).toBe(CARD_DEFS.Footman.base); // no +2, Bannerman is negated
  });

  it("without an active Suppressor, Bannerman's buff lands normally", () => {
    const board: Board = new Map();
    place(board, 3, 2, "Bannerman", "p2");
    const footman = place(board, 4, 2, "Footman", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    expect(find(cards, footman.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 2);
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
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base); // negated, no own +1
    expect(find(cards, f0.instanceId).finalValue).toBe(CARD_DEFS.Footman.base + 1); // still sees a 3-line via f1
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
    expect(find(cards, f1.instanceId).finalValue).toBe(CARD_DEFS.Footman.base);
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
