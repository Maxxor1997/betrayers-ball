import { describe, expect, it } from "vitest";
import { buildDeck, deal, dealNewGame, shuffle } from "../deck";
import { ALL_CARD_IDS, CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { CardBucket, CardId } from "../types";

/** Sum of every card's copy count at `playerCount`, derived from CARD_DEFS -- the
 * expected total, computed independently of `buildDeck`'s own iteration. */
function totalCopiesAt(playerCount: number): number {
  return ALL_CARD_IDS.reduce((sum, id) => sum + copiesForPlayerCount(CARD_DEFS[id], playerCount), 0);
}

/** Same sum as `totalCopiesAt`, broken down by bucket. */
function bucketTotalsAt(playerCount: number): Record<CardBucket, number> {
  const totals: Record<CardBucket, number> = { Slam: 0, Engine: 0, Control: 0 };
  for (const id of ALL_CARD_IDS) totals[CARD_DEFS[id].bucket] += copiesForPlayerCount(CARD_DEFS[id], playerCount);
  return totals;
}

describe("cards", () => {
  it("Footman is the base-value benchmark", () => {
    expect(CARD_DEFS.Footman.base).toBe(5);
  });
});

describe("buildDeck", () => {
  it("totals the sum of every card's copy count at 2 players", () => {
    expect(buildDeck(2)).toHaveLength(totalCopiesAt(2));
  });

  it("matches each card's per-player-count copy count, at every supported player count", () => {
    for (let playerCount = MIN_PLAYERS; playerCount <= MAX_PLAYERS; playerCount++) {
      const deck = buildDeck(playerCount);
      const counts: Record<string, number> = {};
      for (const card of deck) counts[card.cardId] = (counts[card.cardId] ?? 0) + 1;
      for (const cardId of ALL_CARD_IDS) {
        expect(counts[cardId] ?? 0).toBe(copiesForPlayerCount(CARD_DEFS[cardId], playerCount));
      }
    }
  });

  it("every bucket has at least one deck copy at 2 players", () => {
    const totals = bucketTotalsAt(2);
    for (const bucket of Object.keys(totals) as CardBucket[]) {
      expect(totals[bucket]).toBeGreaterThan(0);
    }
  });

  it("assigns every card a unique instanceId", () => {
    const deck = buildDeck(2);
    const ids = new Set(deck.map((c) => c.instanceId));
    expect(ids.size).toBe(deck.length);
  });
});

describe("copiesForPlayerCount", () => {
  it("returns 0 regardless of count when disabled is true", () => {
    const def = { ...CARD_DEFS.Footman, disabled: true };
    expect(copiesForPlayerCount(def, 2)).toBe(0);
    expect(copiesForPlayerCount(def, 8)).toBe(0);
  });

  it("looks up the count for the given player count", () => {
    const def = { ...CARD_DEFS.Footman, count: [1, 2, 3, 4, 5, 6, 7] };
    expect(copiesForPlayerCount(def, 2)).toBe(1);
    expect(copiesForPlayerCount(def, 5)).toBe(4);
    expect(copiesForPlayerCount(def, 8)).toBe(7);
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
    const deck = buildDeck(2);
    const { hands, remainingDeck } = deal(deck, ["p1", "p2"], 7);
    expect(hands.p1).toHaveLength(7);
    expect(hands.p2).toHaveLength(7);
    expect(hands.p1.every((c) => c.ownerId === "p1")).toBe(true);
    expect(hands.p2.every((c) => c.ownerId === "p2")).toBe(true);
    expect(remainingDeck).toHaveLength(deck.length - 14);
  });

  it("deals face-down cards", () => {
    const deck = buildDeck(2);
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
    expect(remainingDeck).toHaveLength(totalCopiesAt(2) - 14);
  });
});
