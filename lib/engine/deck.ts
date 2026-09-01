import { CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { CardId, CardInstance, DeckCard, PlayerState } from "./types";

export type Rng = () => number;

let instanceCounter = 0;
export function resetInstanceCounter(): void {
  instanceCounter = 0;
}
function nextInstanceId(): string {
  return `card-${instanceCounter++}`;
}

export function buildDeck(playerCount: number): DeckCard[] {
  const deck: DeckCard[] = [];
  for (const cardId of Object.keys(CARD_DEFS) as CardId[]) {
    const copies = copiesForPlayerCount(CARD_DEFS[cardId], playerCount);
    for (let i = 0; i < copies; i++) {
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
  const deck = shuffle(buildDeck(playerIds.length), rng);
  const { hands, remainingDeck } = deal(deck, playerIds, handSize);
  const players: PlayerState[] = playerIds.map((id) => ({
    id,
    hand: hands[id],
    isAI: false,
  }));
  return { players, remainingDeck };
}

/**
 * Hall of Fortunes only: redraws a fresh, up-to-3-card offer from the shared undrawn
 * pool -- independently random every time, not a subset of some larger fixed hand.
 * `previousHand` (whatever's left of the player's last offer -- 0 if they placed their
 * whole offer somehow, more commonly 2 leftover unplaced cards) is returned to the
 * pool and reshuffled in first, so nothing is created or destroyed: the same cards
 * that exist across the whole deck at game start are exactly what circulates through
 * every player's offers all game, and an unplaced card can resurface later (to the
 * same player or an opponent).
 *
 * The 3 offered cards are always distinct BY CARD TYPE (see reckoning's own
 * "3 random, unique cards" description) -- walks the shuffled pool in order, taking
 * the first card of each new cardId it hasn't already picked and returning every
 * skipped-over duplicate to the deck untouched, rather than a plain slice(0, 3) of
 * the shuffled pool (which could easily hand back e.g. two Footmen at once, since the
 * pool holds every remaining COPY, not just distinct types). Draws fewer than 3 only
 * once the pool has fewer than 3 *distinct types* left (very late game).
 */
export function redrawOffer(
  deck: DeckCard[],
  previousHand: CardInstance[],
  ownerId: string,
  rng: Rng = Math.random
): { hand: CardInstance[]; deck: DeckCard[] } {
  const returned: DeckCard[] = previousHand.map((c) => ({ instanceId: c.instanceId, cardId: c.cardId }));
  const pool = shuffle([...deck, ...returned], rng);
  const seenCardIds = new Set<CardId>();
  const offer: DeckCard[] = [];
  const rest: DeckCard[] = [];
  for (const c of pool) {
    if (offer.length < 3 && !seenCardIds.has(c.cardId)) {
      seenCardIds.add(c.cardId);
      offer.push(c);
    } else {
      rest.push(c);
    }
  }
  return {
    hand: offer.map((c) => ({ ...c, ownerId, faceUp: false })),
    deck: rest,
  };
}
