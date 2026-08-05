import { getAdjacentCards, parsePosKey } from "./board";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { Board, BoardBounds, CardId, CenterEffectId, Position } from "./types";

export interface ResolvedCard {
  instanceId: string;
  cardId: CardId;
  ownerId: string;
  position: Position;
  faceUp: boolean;
  baseValue: number;
  finalValue: number;
  negated: boolean;
}

export interface ResolutionResult {
  cards: ResolvedCard[];
  totalsByOwner: Record<string, number>;
  /** Champion of the Weak: who the center card went to and for how much, if anyone. */
  centerAward: { value: number; ownerId: string } | null;
  /** Kingslayer: instanceIds of the highest-value card(s), zeroed out. */
  kingslayerZeroed: string[];
}

/**
 * Step 1 — Suppression pass. Cards with a `negatesNeighborsIf` hook (currently just
 * Suppressor) negate adjacent cards whose hook condition is met: their own modifiers
 * and outgoing effects are cancelled (base value only). Cards with the hook are immune
 * to negation themselves (so e.g. two adjacent Suppressors never negate each other).
 * See lib/content/cards.ts.
 */
function computeNegatedInstanceIds(board: Board, bounds: BoardBounds): Set<string> {
  const negated = new Set<string>();
  for (const [key, c] of board.entries()) {
    const negatesNeighborsIf = CARD_DEFS[c.cardId].negatesNeighborsIf;
    if (!negatesNeighborsIf) continue;
    const pos = parsePosKey(key);
    if (!negatesNeighborsIf({ board, bounds, pos })) continue;
    for (const neighbor of getAdjacentCards(board, bounds, pos)) {
      if (!CARD_DEFS[neighbor.cardId].negatesNeighborsIf) negated.add(neighbor.instanceId);
    }
  }
  return negated;
}

/**
 * Step 2 — Value-modifying pass. Every non-negated card's `valueModifier` hook
 * computes simultaneously off base values, positions, identities, ownership, and
 * flip-state — never another card's resolved value. Effects are either "self" (the
 * source card modifies its own value, e.g. Commander) or "outgoing" (the source
 * modifies neighbors, e.g. Bannerman); both are skipped entirely if the source is
 * negated. Incoming effects still land on negated targets — negation only cancels a
 * card's own modifiers and outgoing effects, not its identity/base/flip-state as read
 * by others (a negated Footman still links its neighbors' line; a negated Warlord
 * still counts toward other Warlords' penalty). See lib/content/cards.ts.
 */
function computeValueModifiers(
  board: Board,
  bounds: BoardBounds,
  round: number,
  negated: Set<string>,
  centerEffect: CenterEffectId
): Map<string, number> {
  const deltas = new Map<string, number>();
  const addDelta = (instanceId: string, amount: number) => {
    deltas.set(instanceId, (deltas.get(instanceId) ?? 0) + amount);
  };

  for (const [key, c] of board.entries()) {
    if (negated.has(c.instanceId)) continue;
    const pos = parsePosKey(key);
    CARD_DEFS[c.cardId].valueModifier?.({ board, bounds, round, pos, self: c, addDelta });
  }

  // Center-effect scoring-time passes. These are board rules, not printed card text,
  // so they apply regardless of negation. See lib/content/centerEffects.ts.
  CENTER_EFFECTS[centerEffect].valueModifiers?.(board, bounds, addDelta);

  return deltas;
}

/** Step 3 — Zeroing pass. Non-negated cards with a `zeroesAdjacentIf` hook (Plague Bearer) zero the cards it returns. */
function applyZeroingPass(board: Board, bounds: BoardBounds, negated: Set<string>, values: Map<string, number>): void {
  for (const [key, c] of board.entries()) {
    const zeroesAdjacentIf = CARD_DEFS[c.cardId].zeroesAdjacentIf;
    if (!zeroesAdjacentIf || negated.has(c.instanceId)) continue;
    const pos = parsePosKey(key);
    for (const instanceId of zeroesAdjacentIf({ board, bounds, pos })) {
      values.set(instanceId, 0);
    }
  }
}

/** Step 4 — Floors. Cards with `floorAtZero` (Warlord, Exile) floor at 0. */
function applyFloors(board: Board, values: Map<string, number>): void {
  for (const c of board.values()) {
    if (!CARD_DEFS[c.cardId].floorAtZero) continue;
    const v = values.get(c.instanceId) ?? 0;
    if (v < 0) values.set(c.instanceId, 0);
  }
}

/**
 * Runs the full spec resolution order (suppression -> value-modifying -> zeroing ->
 * floors -> freeze -> post-resolution) and returns each card's frozen final value plus
 * per-owner totals. `round` is the global round the game ended on (feeds Chronicler).
 *
 * `centerEffect` and `playerIds` are optional and default to the pre-center-effects
 * behavior (`"none"`, totals built only from owners who placed a card) so existing
 * callers are unaffected. Pass `playerIds` when using `championOfTheWeak` so a player
 * with zero cards can still be the unique last place.
 */
export function resolveBoard(
  board: Board,
  bounds: BoardBounds,
  round: number,
  centerEffect: CenterEffectId = "none",
  playerIds?: string[]
): ResolutionResult {
  const negated = computeNegatedInstanceIds(board, bounds);
  const deltas = computeValueModifiers(board, bounds, round, negated, centerEffect);

  const values = new Map<string, number>();
  for (const c of board.values()) {
    values.set(c.instanceId, CARD_DEFS[c.cardId].base + (deltas.get(c.instanceId) ?? 0));
  }

  applyZeroingPass(board, bounds, negated, values);
  applyFloors(board, values);

  const cards: ResolvedCard[] = [];
  const totalsByOwner: Record<string, number> = {};
  if (playerIds) for (const id of playerIds) totalsByOwner[id] = 0;

  for (const [key, c] of board.entries()) {
    const finalValue = values.get(c.instanceId) ?? CARD_DEFS[c.cardId].base;
    cards.push({
      instanceId: c.instanceId,
      cardId: c.cardId,
      ownerId: c.ownerId,
      position: parsePosKey(key),
      faceUp: c.faceUp,
      baseValue: CARD_DEFS[c.cardId].base,
      finalValue,
      negated: negated.has(c.instanceId),
    });
    totalsByOwner[c.ownerId] = (totalsByOwner[c.ownerId] ?? 0) + finalValue;
  }

  const postResult = CENTER_EFFECTS[centerEffect].postResolution?.({ board, bounds, negated, cards, totalsByOwner, playerIds });

  return {
    cards,
    totalsByOwner,
    centerAward: postResult?.centerAward ?? null,
    kingslayerZeroed: postResult?.kingslayerZeroed ?? [],
  };
}
