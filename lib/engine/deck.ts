import { CARD_DEFS } from "./cards";
import { CardId, CardInstance, DeckCard, PlayerState } from "./types";

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
  for (const cardId of Object.keys(CARD_DEFS) as CardId[]) {
    for (let i = 0; i < CARD_DEFS[cardId].count; i++) {
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

/**
 * Discards every player's current hand and redeals the same count back to each of
 * them (for the Reckoning center effect). Discarded hands are recycled into the same
 * pool as the undrawn deck before reshuffling and redealing -- not drawn only from
 * `deck` -- so there are always exactly enough cards regardless of player count: the
 * pool is `deck + everyone's discarded hands`, and that's always >= what's being
 * redealt, since the discarded hands alone already equal that count. A card can land
 * back with its original owner or move to someone else; that's an intentional
 * consequence of a shared shuffled pool, not tracked per-player discard piles.
 */
export function redrawHands(
  deck: DeckCard[],
  players: PlayerState[],
  rng: Rng = Math.random
): { players: PlayerState[]; remainingDeck: DeckCard[] } {
  const discarded: DeckCard[] = players.flatMap((p) => p.hand.map((c) => ({ instanceId: c.instanceId, cardId: c.cardId })));
  const pool = shuffle([...deck, ...discarded], rng);

  let cursor = 0;
  const newPlayers: PlayerState[] = players.map((p) => {
    const newHand: CardInstance[] = [];
    for (let i = 0; i < p.hand.length; i++) {
      const deckCard = pool[cursor++];
      if (!deckCard) throw new Error("Deck ran out of cards while redrawing");
      newHand.push({ ...deckCard, ownerId: p.id, faceUp: false });
    }
    return { ...p, hand: newHand };
  });

  return { players: newPlayers, remainingDeck: pool.slice(cursor) };
}
