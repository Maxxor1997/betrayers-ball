import { describe, expect, it } from "vitest";
import { buildDeck, DECK_COPY_COUNTS, deal, dealNewGame, shuffle } from "../deck";
import { ALL_CARD_IDS, CARD_DEFS } from "../cards";
import { CardId } from "../types";

describe("cards", () => {
  it("has all 16 cards from the spec", () => {
    expect(ALL_CARD_IDS).toHaveLength(16);
  });

  it("Footman is the base-value benchmark", () => {
    expect(CARD_DEFS.Footman.base).toBe(5);
  });
});

describe("buildDeck", () => {
  it("totals 68 cards", () => {
    expect(buildDeck()).toHaveLength(68);
  });

  it("matches the spec's per-card copy counts", () => {
    const deck = buildDeck();
    const counts: Record<string, number> = {};
    for (const card of deck) counts[card.cardId] = (counts[card.cardId] ?? 0) + 1;
    for (const cardId of ALL_CARD_IDS) {
      expect(counts[cardId]).toBe(DECK_COPY_COUNTS[cardId]);
    }
  });

  it("bucket totals match spec (Slam 26 / Engine 25 / Control 17)", () => {
    const totals = { Slam: 0, Engine: 0, Control: 0 };
    for (const cardId of ALL_CARD_IDS) {
      totals[CARD_DEFS[cardId].bucket] += DECK_COPY_COUNTS[cardId];
    }
    expect(totals).toEqual({ Slam: 26, Engine: 25, Control: 17 });
  });

  it("assigns every card a unique instanceId", () => {
    const deck = buildDeck();
    const ids = new Set(deck.map((c) => c.instanceId));
    expect(ids.size).toBe(deck.length);
  });
});

describe("shuffle", () => {
  it("is deterministic given the same RNG sequence", () => {
    const items = [1, 2, 3, 4, 5];
    const rng = () => 0.5;
    expect(shuffle(items, rng)).toEqual(shuffle(items, rng));
  });

  it("preserves all elements", () => {
    const items = ["a", "b", "c", "d"];
    const shuffled = shuffle(items, () => 0.9);
    expect(shuffled.slice().sort()).toEqual(items.slice().sort());
  });

  it("does not mutate the input array", () => {
    const items = [1, 2, 3];
    const copy = items.slice();
    shuffle(items, () => 0.3);
    expect(items).toEqual(copy);
  });
});

describe("deal", () => {
  it("deals handSize cards to each player and assigns ownerId", () => {
    const deck = buildDeck();
    const { hands, remainingDeck } = deal(deck, ["p1", "p2"], 7);
    expect(hands.p1).toHaveLength(7);
    expect(hands.p2).toHaveLength(7);
    expect(hands.p1.every((c) => c.ownerId === "p1")).toBe(true);
    expect(hands.p2.every((c) => c.ownerId === "p2")).toBe(true);
    expect(remainingDeck).toHaveLength(deck.length - 14);
  });

  it("deals face-down cards", () => {
    const deck = buildDeck();
    const { hands } = deal(deck, ["p1"], 7);
    expect(hands.p1.every((c) => c.faceUp === false)).toBe(true);
  });

  it("throws if the deck runs out", () => {
    const deck: { instanceId: string; cardId: CardId }[] = [{ instanceId: "x", cardId: "Footman" }];
    expect(() => deal(deck, ["p1"], 7)).toThrow();
  });
});

describe("dealNewGame", () => {
  it("produces players with hands and a reduced deck", () => {
    const { players, remainingDeck } = dealNewGame(["p1", "p2"], 7, () => 0.42);
    expect(players).toHaveLength(2);
    expect(players[0].hand).toHaveLength(7);
    expect(remainingDeck).toHaveLength(68 - 14);
  });
});
