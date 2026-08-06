import { getAdjacentCards, parsePosKey } from "./board";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { Board, BoardBounds, CardId, CenterEffectId, Position } from "./types";

/** One line of a card's scoring breakdown -- `label` names the source, `amount` its contribution. */
export interface ScoreContribution {
  label: string;
  amount: number;
}

/**
 * Breakdown label for a card's own printed floor (Warlord/Exile) hitting 0. Exported
 * so a breakdown UI can filter this one out if it wants to -- unlike "Kingslayer", it's
 * not a surprise interaction with another card, just the card's own known rule, so it's
 * often redundant with the Final value already shown.
 */
export const FLOORED_AT_ZERO_LABEL = "Floored at 0";

export interface ResolvedCard {
  instanceId: string;
  cardId: CardId;
  ownerId: string;
  position: Position;
  faceUp: boolean;
  baseValue: number;
  finalValue: number;
  negated: boolean;
  /** Every contribution that adds up to `finalValue`, starting with "Base" -- for a scoring-breakdown UI. */
  breakdown: ScoreContribution[];
}

export interface ResolutionResult {
  cards: ResolvedCard[];
  totalsByOwner: Record<string, number>;
  /** Champion of the Weak: who the center card went to and for how much, if anyone. */
  centerAward: { value: number; ownerId: string } | null;
  /** Kingslayer: instanceIds of the highest-value face-up card(s) hit. */
  kingslayerHit: string[];
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
 *
 * Returns each card's contributions (not just their sum) so a scoring breakdown UI can
 * show exactly where the points came from.
 */
function computeValueModifiers(
  board: Board,
  bounds: BoardBounds,
  round: number,
  negated: Set<string>,
  centerEffect: CenterEffectId
): Map<string, ScoreContribution[]> {
  const contributions = new Map<string, ScoreContribution[]>();
  const addDelta = (instanceId: string, amount: number, label: string) => {
    const list = contributions.get(instanceId);
    if (list) list.push({ label, amount });
    else contributions.set(instanceId, [{ label, amount }]);
  };

  for (const [key, c] of board.entries()) {
    if (negated.has(c.instanceId)) continue;
    const pos = parsePosKey(key);
    CARD_DEFS[c.cardId].valueModifier?.({ board, bounds, round, pos, self: c, addDelta });
  }

  // Center-effect scoring-time passes. These are board rules, not printed card text,
  // so they apply regardless of negation. See lib/content/centerEffects.ts.
  CENTER_EFFECTS[centerEffect].valueModifiers?.(board, bounds, addDelta);

  return contributions;
}

/** Step 3 — Floors. Cards with `floorAtZero` (Warlord, Exile) floor at 0. Returns the instanceIds actually floored. */
function applyFloors(board: Board, values: Map<string, number>): Set<string> {
  const floored = new Set<string>();
  for (const c of board.values()) {
    if (!CARD_DEFS[c.cardId].floorAtZero) continue;
    const v = values.get(c.instanceId) ?? 0;
    if (v < 0) {
      values.set(c.instanceId, 0);
      floored.add(c.instanceId);
    }
  }
  return floored;
}

/**
 * Runs the full spec resolution order (suppression -> value-modifying -> floors ->
 * freeze -> post-resolution) and returns each card's frozen final value plus
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
  const contributions = computeValueModifiers(board, bounds, round, negated, centerEffect);

  const values = new Map<string, number>();
  for (const c of board.values()) {
    const rawTotal = CARD_DEFS[c.cardId].base + (contributions.get(c.instanceId) ?? []).reduce((sum, d) => sum + d.amount, 0);
    values.set(c.instanceId, rawTotal);
  }

  applyFloors(board, values);

  const cards: ResolvedCard[] = [];
  const totalsByOwner: Record<string, number> = {};
  if (playerIds) for (const id of playerIds) totalsByOwner[id] = 0;

  for (const [key, c] of board.entries()) {
    const base = CARD_DEFS[c.cardId].base;
    const cardContributions = contributions.get(c.instanceId) ?? [];
    const finalValue = values.get(c.instanceId) ?? base;

    const breakdown: ScoreContribution[] = [{ label: "Base", amount: base }, ...cardContributions];
    const rawTotal = base + cardContributions.reduce((sum, d) => sum + d.amount, 0);
    if (finalValue !== rawTotal) {
      breakdown.push({ label: FLOORED_AT_ZERO_LABEL, amount: finalValue - rawTotal });
    }

    cards.push({
      instanceId: c.instanceId,
      cardId: c.cardId,
      ownerId: c.ownerId,
      position: parsePosKey(key),
      faceUp: c.faceUp,
      baseValue: base,
      finalValue,
      negated: negated.has(c.instanceId),
      breakdown,
    });
    totalsByOwner[c.ownerId] = (totalsByOwner[c.ownerId] ?? 0) + finalValue;
  }

  const postResult = CENTER_EFFECTS[centerEffect].postResolution?.({ board, bounds, negated, cards, totalsByOwner, playerIds });

  return {
    cards,
    totalsByOwner,
    centerAward: postResult?.centerAward ?? null,
    kingslayerHit: postResult?.kingslayerHit ?? [],
  };
}
