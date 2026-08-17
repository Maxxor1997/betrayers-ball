import { getAdjacentCards, parsePosKey } from "./board";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { Board, BoardBounds, CardId, CardInstance, CenterEffectId, Position } from "./types";

/** One Infiltrator/target pair's identity swap -- see computeIdentitySwaps. */
interface IdentitySwap {
  originalCardId: CardId;
  newCardId: CardId;
}

/**
 * Step 0 — Facestealer's identity swap, computed once off the original board before
 * anything else runs (suppression and value-modifiers both need to know each card's
 * *effective* base/rule, so this has to land first). Every face-down Infiltrator
 * independently swaps base and printed rule (not cardId itself -- see effectiveCardId's
 * doc comment for what stays real) with whichever adjacent face-up card (any owner,
 * never another Infiltrator) has the highest *printed* base; resolved value doesn't
 * exist yet at this point, so printed base is the only thing there is to compare. This
 * isn't a strict 1-for-1 exchange: multiple Facestealers can each independently swap
 * with the same popular target (the target's own effective rule still just becomes a
 * single Infiltrator's; each Facestealer independently borrows its own copy of the
 * target's rule), so there's no ordering or tie-break to resolve -- ties among a single
 * Facestealer's own candidates break by board/placement order (board.entries()
 * iteration order), same as everywhere else in this engine that needs a deterministic
 * first-among-equals.
 */
function computeIdentitySwaps(board: Board, bounds: BoardBounds): Map<string, IdentitySwap> {
  const swaps = new Map<string, IdentitySwap>();
  for (const [key, c] of board.entries()) {
    if (c.faceUp || c.cardId !== "Infiltrator") continue;
    const pos = parsePosKey(key);
    const candidates = getAdjacentCards(board, bounds, pos).filter((n) => n.faceUp && n.cardId !== "Infiltrator");
    if (candidates.length === 0) continue;
    let target = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (CARD_DEFS[candidate.cardId].base > CARD_DEFS[target.cardId].base) target = candidate;
    }
    swaps.set(c.instanceId, { originalCardId: "Infiltrator", newCardId: target.cardId });
    swaps.set(target.instanceId, { originalCardId: target.cardId, newCardId: "Infiltrator" });
  }
  return swaps;
}

/**
 * Which CardDef's base/valueModifier/negatesNeighborsIf a card instance actually scores
 * with -- its own real `cardId` unless computeIdentitySwaps swapped it, in which case
 * whatever it's currently borrowing. Deliberately never mutates the board or a card's
 * own `cardId`: the board still shows the card that was actually placed there (its art,
 * its name, its stats-tracking identity all stay real -- see game_spec.md's "the board
 * is what's actually there" spirit), and every *other* card's own effect still reads
 * neighbors' real identities off the untouched board (so e.g. Bannerman's "is this
 * neighbor a Footman" check is never fooled by a Facestealer borrowing Footman's rule --
 * only the borrowing card's own scoring computation is affected, nothing about how it
 * looks to everyone else). Falls back to the instance's own cardId when there's no swap,
 * so every caller can use this unconditionally instead of checking swaps.has() first.
 */
function effectiveCardId(instanceId: string, ownCardId: CardId, swaps: Map<string, IdentitySwap>): CardId {
  return swaps.get(instanceId)?.newCardId ?? ownCardId;
}

/** One line of a card's scoring breakdown -- `label` names the source, `amount` its contribution. */
export interface ScoreContribution {
  label: string;
  amount: number;
  /**
   * "self" for the card's own printed rule -- Base, its own valueModifier hook's
   * self-effects (addDelta'd onto its own instanceId), and the universal floor at 0 --
   * "external" for anything caused by a neighbor's outgoing effect or a center
   * effect. Lets a stats tool (see the playtest simulator) separate a card's "own"
   * score from value it only got because of board context around it.
   */
  source: "self" | "external";
  /**
   * instanceId of the card whose own valueModifier caused this contribution -- only
   * set for "external" contributions caused by another card's outgoing effect (not a
   * center effect, which has no card responsible, and not "self" contributions, where
   * the target itself is trivially the source). Lets a stats tool attribute a delta
   * back to exactly which card instance caused it, even when multiple copies of the
   * same card exist on the board -- see the playtest simulator's disruption tally.
   */
  sourceInstanceId?: string;
  /**
   * True for a line that explains something for the breakdown/disruption tally but
   * doesn't actually count toward the card's own finalValue -- currently only used for
   * a negated card's "here's what got cancelled" line (see computeValueModifiers): a
   * negated card's real total is always exactly its base, but without a visible entry
   * a stats tool has no way to see that a negator (e.g. Suppressor) caused anything at
   * all, since negation works by skipping the target's valueModifier entirely rather
   * than applying a tracked delta. Omitted (falsy) for every normal contribution.
   */
  informational?: boolean;
}

/**
 * Breakdown label for a card's own printed floor rule hitting 0. Exported so a
 * breakdown UI can filter this one out if it wants to -- unlike a surprise interaction
 * contributed by another card or center effect, it's just the card's own known rule,
 * so it's often redundant with the Final value already shown.
 */
export const FLOORED_AT_ZERO_LABEL = "Floored at 0";

export interface ResolvedCard {
  instanceId: string;
  /** The card actually placed on the board -- never rewritten by a Facestealer swap (see effectiveCardId); only its *scoring* (base/breakdown/finalValue) reflects a swap, not this. */
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
  /** Which player the center pseudo-card's (possibly modified) value transferred to and for how much, if the active center effect makes that kind of transfer. */
  centerAward: { value: number; ownerId: string } | null;
  /** instanceIds of any card(s) hit by a center effect that subtracts from the board's highest value, if the active center effect does that. */
  kingslayerHit: string[];
}

/**
 * Step 1 — Suppression pass. Cards with a `negatesNeighborsIf` hook negate adjacent
 * cards whose hook condition is met: their own modifiers and outgoing effects are
 * cancelled (base value only). Cards with the hook are immune to negation themselves
 * (so e.g. two adjacent negating cards never negate each other). See lib/content/cards.ts.
 *
 * Returns which negator(s) caused each negated instance -- almost always exactly one,
 * but a card boxed in by two qualifying negators at once is possible, so this is a
 * list, not a single id. Used by computeValueModifiers below to attribute what got
 * cancelled back to whichever negator(s) caused it; computeNegatedInstanceIds (the
 * plain membership version every other caller wants) is defined in terms of this.
 */
function computeNegatorsOf(board: Board, bounds: BoardBounds, swaps: Map<string, IdentitySwap> = new Map()): Map<string, string[]> {
  const negatorsOf = new Map<string, string[]>();
  for (const [key, c] of board.entries()) {
    const negatesNeighborsIf = CARD_DEFS[effectiveCardId(c.instanceId, c.cardId, swaps)].negatesNeighborsIf;
    if (!negatesNeighborsIf) continue;
    const pos = parsePosKey(key);
    if (!negatesNeighborsIf({ board, bounds, pos })) continue;
    for (const neighbor of getAdjacentCards(board, bounds, pos)) {
      if (CARD_DEFS[effectiveCardId(neighbor.instanceId, neighbor.cardId, swaps)].negatesNeighborsIf) continue; // negation-immune
      const list = negatorsOf.get(neighbor.instanceId);
      if (list) list.push(c.instanceId);
      else negatorsOf.set(neighbor.instanceId, [c.instanceId]);
    }
  }
  return negatorsOf;
}

/** Plain "is this instance negated at all" membership -- what every caller outside this file actually wants (e.g. Board.tsx's rendering, pseudoCardLiveValue). Never swap-aware -- Facestealer's swap is a resolveBoard-only concept (see effectiveCardId), and this is used for live, pre-scoring board rendering. */
export function computeNegatedInstanceIds(board: Board, bounds: BoardBounds): Set<string> {
  return new Set(computeNegatorsOf(board, bounds).keys());
}

/**
 * A card's value from its own printed rule alone -- base plus only the deltas its own
 * valueModifier applies to itself -- found by running that hook in isolation. Used
 * below to find what a negated card's own effect *would* have been, so negation's
 * real impact shows up in the breakdown instead of just silently vanishing. Same
 * "simultaneous, only ever reads board/identity, never another card's resolved value"
 * computation every valueModifier already does -- this doesn't add a new kind of read,
 * it just runs one in isolation to see what it would have produced. `self` is patched
 * to the card's *effective* identity (see effectiveCardId) so a swapped card's own
 * self-referential lookups (e.g. Pretender's `CARD_DEFS[self.cardId].base`) see the
 * rule it's actually borrowing, not its real, unchanged identity.
 */
function selfContributionOnly(board: Board, bounds: BoardBounds, round: number, pos: Position, card: CardInstance, swaps: Map<string, IdentitySwap>): number {
  let total = 0;
  const cardId = effectiveCardId(card.instanceId, card.cardId, swaps);
  CARD_DEFS[cardId].valueModifier?.({
    board,
    bounds,
    round,
    pos,
    self: { ...card, cardId },
    addDelta: (instanceId, amount) => {
      if (instanceId === card.instanceId) total += amount;
    },
  });
  return total;
}

/**
 * Step 2 — Value-modifying pass. Every non-negated card's `valueModifier` hook
 * computes simultaneously off base values, positions, identities, ownership, and
 * flip-state — never another card's resolved value. Effects are either "self" (the
 * source card modifies its own value) or "outgoing" (the source modifies neighbors);
 * both are skipped entirely if the source is negated. Incoming effects still land on
 * negated targets — negation only cancels a card's own modifiers and outgoing effects,
 * not its identity/base/flip-state as read by others (e.g. a negated card that other
 * cards' effects key off by type or by counting still reads correctly to them). See
 * lib/content/cards.ts.
 *
 * Returns each card's contributions (not just their sum) so a scoring breakdown UI can
 * show exactly where the points came from.
 */
function computeValueModifiers(
  board: Board,
  bounds: BoardBounds,
  round: number,
  negated: Set<string>,
  negatorsOf: Map<string, string[]>,
  centerEffect: CenterEffectId,
  swaps: Map<string, IdentitySwap>
): Map<string, ScoreContribution[]> {
  const contributions = new Map<string, ScoreContribution[]>();
  const push = (
    instanceId: string,
    amount: number,
    label: string,
    source: ScoreContribution["source"],
    sourceInstanceId?: string,
    informational?: boolean
  ) => {
    const list = contributions.get(instanceId);
    const entry: ScoreContribution = { label, amount, source, sourceInstanceId, informational };
    if (list) list.push(entry);
    else contributions.set(instanceId, [entry]);
  };

  for (const [key, c] of board.entries()) {
    if (negated.has(c.instanceId)) continue;
    const pos = parsePosKey(key);
    // A card's own hook can addDelta either onto itself (a self-effect) or onto a
    // neighbor (an outgoing effect) -- which one determines whether the *target*
    // should count this as its own printed rule or as something a neighbor did to it.
    const addDelta = (instanceId: string, amount: number, label: string) => {
      const isSelf = instanceId === c.instanceId;
      push(instanceId, amount, label, isSelf ? "self" : "external", isSelf ? undefined : c.instanceId);
    };
    const cardId = effectiveCardId(c.instanceId, c.cardId, swaps);
    CARD_DEFS[cardId].valueModifier?.({ board, bounds, round, pos, self: { ...c, cardId }, addDelta });
  }

  // Negation cancels a target's own valueModifier entirely (see the loop above), so
  // without this, neither its breakdown nor any stat built on top of it (disruption
  // tallies) would ever show that a negator did anything at all. This doesn't change
  // the negated card's real value -- see resolveBoard's `informational` filtering --
  // it only makes the denial visible/attributable, using exactly the "external,
  // sourceInstanceId" shape the disruption tally already knows how to read.
  if (negatorsOf.size > 0) {
    const byInstanceId = new Map<string, { pos: Position; card: CardInstance }>();
    for (const [key, c] of board.entries()) byInstanceId.set(c.instanceId, { pos: parsePosKey(key), card: c });

    for (const [instanceId, negatorIds] of negatorsOf) {
      const target = byInstanceId.get(instanceId);
      if (!target) continue;
      const deniedSelfContribution = selfContributionOnly(board, bounds, round, target.pos, target.card, swaps);
      if (deniedSelfContribution === 0) continue; // nothing was actually denied
      const share = deniedSelfContribution / negatorIds.length;
      for (const negatorId of negatorIds) {
        const negatorName = byInstanceId.get(negatorId) ? CARD_DEFS[byInstanceId.get(negatorId)!.card.cardId].name : "negation";
        push(instanceId, -share, `Negated by ${negatorName}`, "external", negatorId, true);
      }
    }
  }

  // Center-effect scoring-time passes. These are board rules, not printed card text,
  // so they apply regardless of negation, and are always "external" -- never a card's
  // own rule, no matter which card they land on. See lib/content/centerEffects.ts.
  CENTER_EFFECTS[centerEffect].valueModifiers?.(board, bounds, (instanceId, amount, label) => push(instanceId, amount, label, "external"));

  return contributions;
}

/** Step 3 — Floors. Every card floors at 0, universally -- no card's value can ever go negative, regardless of how many negative effects stack onto it. Returns the instanceIds actually floored. */
function applyFloors(board: Board, values: Map<string, number>): Set<string> {
  const floored = new Set<string>();
  for (const c of board.values()) {
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
  const swaps = computeIdentitySwaps(board, bounds);

  const negatorsOf = computeNegatorsOf(board, bounds, swaps);
  const negated = new Set(negatorsOf.keys());
  const contributions = computeValueModifiers(board, bounds, round, negated, negatorsOf, centerEffect, swaps);

  // `informational` entries (currently just negation's "here's what got cancelled"
  // lines -- see computeValueModifiers) explain something in the breakdown/disruption
  // tally but never count toward the card's own value -- a negated card's real total
  // is always exactly its base, full stop.
  const values = new Map<string, number>();
  for (const c of board.values()) {
    const base = CARD_DEFS[effectiveCardId(c.instanceId, c.cardId, swaps)].base;
    const rawTotal = base + (contributions.get(c.instanceId) ?? []).reduce((sum, d) => sum + (d.informational ? 0 : d.amount), 0);
    values.set(c.instanceId, rawTotal);
  }

  applyFloors(board, values);

  const cards: ResolvedCard[] = [];
  const totalsByOwner: Record<string, number> = {};
  if (playerIds) for (const id of playerIds) totalsByOwner[id] = 0;

  for (const [key, c] of board.entries()) {
    const swap = swaps.get(c.instanceId);
    // The breakdown's "Base" reflects what's actually being *scored* -- the borrowed
    // base when swapped -- even though `cardId` below stays this card's real, unchanged
    // identity (see effectiveCardId's doc comment for why the two can differ).
    const base = CARD_DEFS[effectiveCardId(c.instanceId, c.cardId, swaps)].base;
    const cardContributions = contributions.get(c.instanceId) ?? [];
    const finalValue = values.get(c.instanceId) ?? base;

    const breakdown: ScoreContribution[] = [{ label: "Base", amount: base, source: "self" }];
    if (swap) {
      // Legible post-game annotation for why this card's own numbers don't match its
      // printed rule -- see computeIdentitySwaps. Zero-amount: the swap's real effect
      // is already baked into `base` and `cardContributions` above, this line just
      // explains why.
      const label =
        swap.originalCardId === "Infiltrator"
          ? `${CARD_DEFS.Infiltrator.name} (borrowing ${CARD_DEFS[swap.newCardId].name}'s rule)`
          : `${CARD_DEFS.Infiltrator.name} (its rule was stolen -- scoring as ${CARD_DEFS.Infiltrator.name} instead)`;
      breakdown.push({ label, amount: 0, source: "self" });
    }
    breakdown.push(...cardContributions);
    const rawTotal = base + cardContributions.reduce((sum, d) => sum + (d.informational ? 0 : d.amount), 0);
    if (finalValue !== rawTotal) {
      // The card's own printed floor rule, not something a neighbor did.
      breakdown.push({ label: FLOORED_AT_ZERO_LABEL, amount: finalValue - rawTotal, source: "self" });
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
