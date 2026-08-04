import { CardId, CardInstance, DeckCard, PlayerState } from "./types";

/** Copy counts per game_spec.md v2 deck table. Totals 68 (Slam 26 / Engine 25 / Control 17). */
export const DECK_COPY_COUNTS: Record<CardId, number> = {
  Footman: 12,
  Warlord: 5,
  Giant: 3,
  Exile: 3,
  Pretender: 3,
  Berserker: 8,
  Commander: 5,
  Champion: 5,
  Darkspawn: 4,
  Chronicler: 3,
  Bannerman: 4,
  Skysplitter: 3,
  Earthshaker: 3,
  PlagueBearer: 3,
  Suppressor: 2,
  Headsman: 2,
};

export type Rng = () => number;

let instanceCounter = 0;
export function resetInstanceCounter(): void {
  instanceCounter = 0;
}
function nextInstanceId(): string {
  return `card-${instanceCounter++}`;
}

export function buildDeck(): DeckCard[] {
  const deck: DeckCard[] = [];
  for (const [cardId, count] of Object.entries(DECK_COPY_COUNTS) as [CardId, number][]) {
    for (let i = 0; i < count; i++) {
      deck.push({ instanceId: nextInstanceId(), cardId });
    }
  }
  return deck;
}

/** Fisher-Yates shuffle. Takes an injectable RNG so tests can be deterministic. */
export function shuffle<T>(items: T[], rng: Rng = Math.random): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface DealResult {
  hands: Record<string, CardInstance[]>;
  remainingDeck: DeckCard[];
}

/** Deals `handSize` cards to each player from the (already shuffled) deck, assigning ownerId. */
export function deal(deck: DeckCard[], playerIds: string[], handSize: number): DealResult {
  const hands: Record<string, CardInstance[]> = {};
  for (const playerId of playerIds) hands[playerId] = [];

  let cursor = 0;
  for (const playerId of playerIds) {
    for (let i = 0; i < handSize; i++) {
      const deckCard = deck[cursor++];
      if (!deckCard) {
        throw new Error("Deck ran out of cards while dealing");
      }
      hands[playerId].push({ ...deckCard, ownerId: playerId, faceUp: false });
    }
  }

  return { hands, remainingDeck: deck.slice(cursor) };
}

export function dealNewGame(
  playerIds: string[],
  handSize: number,
  rng: Rng = Math.random
): { players: PlayerState[]; remainingDeck: DeckCard[] } {
  const deck = shuffle(buildDeck(), rng);
  const { hands, remainingDeck } = deal(deck, playerIds, handSize);
  const players: PlayerState[] = playerIds.map((id) => ({
    id,
    hand: hands[id],
    isAI: false,
  }));
  return { players, remainingDeck };
}
