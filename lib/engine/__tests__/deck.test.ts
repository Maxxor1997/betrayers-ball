import { describe, expect, it } from "vitest";
import { buildDeck, deal, dealNewGame, redrawHands, shuffle } from "../deck";
import { ALL_CARD_IDS, CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { CardId, CardInstance, DeckCard, PlayerState } from "../types";

describe("cards", () => {
  it("has all 17 cards (Headsman + Darkspawn merged into Infiltrator)", () => {
    expect(ALL_CARD_IDS).toHaveLength(17);
  });

  it("Footman is the base-value benchmark", () => {
    expect(CARD_DEFS.Footman.base).toBe(5);
  });
});

describe("buildDeck", () => {
  it("totals 78 cards at 2 players", () => {
    expect(buildDeck(2)).toHaveLength(78);
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

  it("bucket totals match current CARD_DEFS bucket assignments at 2 players (Slam 18 / Engine 36 / Control 24)", () => {
    const totals = { Slam: 0, Engine: 0, Control: 0 };
    for (const cardId of ALL_CARD_IDS) {
      totals[CARD_DEFS[cardId].bucket] += copiesForPlayerCount(CARD_DEFS[cardId], 2);
    }
    expect(totals).toEqual({ Slam: 18, Engine: 36, Control: 24 });
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
    expect(remainingDeck).toHaveLength(78 - 14);
  });
});

describe("redrawHands", () => {
  function handCard(cardId: CardId, ownerId: string): CardInstance {
    return { instanceId: `old-${ownerId}-${cardId}-${Math.random()}`, cardId, ownerId, faceUp: false };
  }

  it("gives each player back the same hand size they had, conserving the total card count", () => {
    const { players: dealtPlayers, remainingDeck } = dealNewGame(["p1", "p2"], 7, () => 0.11);
    const { players, remainingDeck: newRemainingDeck } = redrawHands(remainingDeck, dealtPlayers, () => 0.77);

    expect(players[0].hand).toHaveLength(7);
    expect(players[1].hand).toHaveLength(7);
    // Cards keep their identity (instanceId) as they move between deck and hands --
    // redrawing reshuffles the same physical cards, it doesn't mint new ones.
    expect(newRemainingDeck).toHaveLength(remainingDeck.length);
  });

  it("assigns the correct ownerId and resets faceUp on every redealt card", () => {
    const players: PlayerState[] = [
      { id: "p1", hand: [handCard("Footman", "p1"), handCard("Exile", "p1")], isAI: false },
      { id: "p2", hand: [handCard("Warlord", "p2")], isAI: true },
    ];
    const deck: DeckCard[] = [{ instanceId: "d1", cardId: "Gloryseeker" }, { instanceId: "d2", cardId: "Berserker" }];

    const { players: redrawn } = redrawHands(deck, players, () => 0.5);
    expect(redrawn[0].hand).toHaveLength(2);
    expect(redrawn[0].hand.every((c) => c.ownerId === "p1" && c.faceUp === false)).toBe(true);
    expect(redrawn[1].hand).toHaveLength(1);
    expect(redrawn[1].hand.every((c) => c.ownerId === "p2" && c.faceUp === false)).toBe(true);
  });

  it("preserves player id and isAI while replacing hand", () => {
    const players: PlayerState[] = [{ id: "p1", hand: [handCard("Footman", "p1")], isAI: true }];
    const { players: redrawn } = redrawHands([], players, () => 0.5);
    expect(redrawn[0].id).toBe("p1");
    expect(redrawn[0].isAI).toBe(true);
  });

  it("never runs out, even with an empty remaining deck -- discarded hands are recycled first", () => {
    const players: PlayerState[] = [
      { id: "p1", hand: [handCard("Footman", "p1"), handCard("Exile", "p1"), handCard("Warlord", "p1")], isAI: false },
      { id: "p2", hand: [handCard("Gloryseeker", "p2"), handCard("Berserker", "p2")], isAI: false },
    ];
    expect(() => redrawHands([], players, () => 0.5)).not.toThrow();
    const { players: redrawn, remainingDeck } = redrawHands([], players, () => 0.5);
    expect(redrawn[0].hand).toHaveLength(3);
    expect(redrawn[1].hand).toHaveLength(2);
    expect(remainingDeck).toHaveLength(0); // exactly enough, nothing left over
  });
});
