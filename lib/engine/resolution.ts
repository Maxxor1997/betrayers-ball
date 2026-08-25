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
 * anything else runs (suppression and value-modifiers both run against the swapped
 * board -- see applyIdentitySwaps -- so this has to land first). Every face-down
 * Infiltrator independently swaps base and printed rule with whichever adjacent
 * face-up card (any owner, never another Infiltrator) has the highest *printed* base;
 * resolved value doesn't exist yet at this point, so printed base is the only thing
 * there is to compare. This
 * isn't a strict 1-for-1 exchange: multiple Facestealers can each independently swap
 * with the same popular target (the target's own effective rule still just becomes a
 * single Infiltrator's; each Facestealer independently borrows its own copy of the
 * target's rule), so there's no ordering or tie-break to resolve -- ties among a single
 * Facestealer's own candidates break by board/placement order (board.entries()
 * iteration order), same as everywhere else in this engine that needs a deterministic
 * first-among-equals.
 */
function computeIdentitySwaps(board: Board, bounds: BoardBounds): { swaps: Map<string, IdentitySwap>; thievesOf: Map<string, string[]> } {
  const swaps = new Map<string, IdentitySwap>();
  // Reverse edge (target instanceId -> the Facestealer instance(s) that stole from
  // it) -- computeIdentitySwaps' own per-instance map has no way to recover this,
  // since a target's swap entry only records its own new/old cardId, not who did it.
  // Needed so a "value stolen from you" disruption line can be attributed to the
  // correct specific thief instance(s), same "attribute back to exactly which card
  // instance caused it" requirement every other external contribution already meets.
  const thievesOf = new Map<string, string[]>();
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
    const list = thievesOf.get(target.instanceId);
    if (list) list.push(c.instanceId);
    else thievesOf.set(target.instanceId, [c.instanceId]);
  }
  return { swaps, thievesOf };
}

/**
 * Applies computeIdentitySwaps' result to a board -- same positions/owners/instanceIds/
 * faceUp, swapped-in cardIds. Every downstream computation (suppression,
 * valueModifiers, base lookups, center effects) runs against this swapped board, not
 * the original -- the whole point of computing the swap first is that resolution
 * proceeds exactly as if it had genuinely happened: a card that borrowed Warlord's
 * rule IS a Warlord for every other card's neighbor checks too (Bannerman's "is this a
 * Footman", Warlord's own "is there a rival Warlord nearby", everything), not just for
 * its own scoring. The *display* identity (ResolvedCard.cardId, card art, stats
 * tracking) is restored from the original, unswapped board afterward in resolveBoard --
 * see its own comment for why that split matters.
 */
function applyIdentitySwaps(board: Board, swaps: Map<string, IdentitySwap>): Board {
  if (swaps.size === 0) return board;
  const swapped = new Map(board);
  for (const [key, c] of board.entries()) {
    const swap = swaps.get(c.instanceId);
    if (swap) swapped.set(key, { ...c, cardId: swap.newCardId });
  }
  return swapped;
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
  /** The card actually placed on the board -- restored from the original, unswapped board in resolveBoard even though scoring (base/breakdown/finalValue) runs against the swapped one (see applyIdentitySwaps). */
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
function computeNegatorsOf(board: Board, bounds: BoardBounds): Map<string, string[]> {
  const negatorsOf = new Map<string, string[]>();
  for (const [key, c] of board.entries()) {
    const negatesNeighborsIf = CARD_DEFS[c.cardId].negatesNeighborsIf;
    if (!negatesNeighborsIf) continue;
    const pos = parsePosKey(key);
    if (!negatesNeighborsIf({ board, bounds, pos })) continue;
    for (const neighbor of getAdjacentCards(board, bounds, pos)) {
      if (CARD_DEFS[neighbor.cardId].negatesNeighborsIf) continue; // negation-immune
      const list = negatorsOf.get(neighbor.instanceId);
      if (list) list.push(c.instanceId);
      else negatorsOf.set(neighbor.instanceId, [c.instanceId]);
    }
  }
  return negatorsOf;
}

/**
 * Plain "is this instance negated at all" membership -- what every caller outside this
 * file actually wants (e.g. Board.tsx's rendering, pseudoCardLiveValue). Swap-aware
 * (see applyIdentitySwaps) so a live, pre-scoring board reads negation exactly as
 * resolveBoard eventually will -- instanceIds survive the swap, so callers can key off
 * them the same way either way.
 */
export function computeNegatedInstanceIds(board: Board, bounds: BoardBounds): Set<string> {
  const swapped = applyIdentitySwaps(board, computeIdentitySwaps(board, bounds).swaps);
  return new Set(computeNegatorsOf(swapped, bounds).keys());
}

/**
 * Every delta a card's valueModifier hook would produce -- both onto itself and onto
 * any neighbor -- found by running that hook in isolation, keyed by whichever
 * instanceId each addDelta call targeted. Same "simultaneous, only ever reads
 * board/identity, never another card's resolved value" computation every
 * valueModifier already does -- this doesn't add a new kind of read, it just runs one
 * in isolation to see what it would have produced. Two callers reuse this:
 * - Negation (computeValueModifiers below): recovers what a negated card's hook would
 *   have applied, both to itself (`get(card.instanceId)`, the existing "Own rule
 *   (negated)" line) and to its neighbors (every other key -- the neighbors' own
 *   denied bonus/penalty, otherwise silently vanishing with zero trace anywhere).
 * - Facestealer's swap (resolveBoard): recovers what a swap target's TRUE identity
 *   would have contributed to itself, by passing a card object with `cardId`
 *   overridden to the stolen-from identity -- see resolveBoard's own comment.
 */
function contributionsOf(board: Board, bounds: BoardBounds, round: number, pos: Position, card: CardInstance): Map<string, number> {
  const result = new Map<string, number>();
  CARD_DEFS[card.cardId].valueModifier?.({
    board,
    bounds,
    round,
    pos,
    self: card,
    addDelta: (instanceId, amount) => {
      result.set(instanceId, (result.get(instanceId) ?? 0) + amount);
    },
  });
  return result;
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
  centerEffect: CenterEffectId
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
    CARD_DEFS[c.cardId].valueModifier?.({ board, bounds, round, pos, self: c, addDelta });
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
      const negatorName = (negatorId: string) => (byInstanceId.get(negatorId) ? CARD_DEFS[byInstanceId.get(negatorId)!.card.cardId].name : "negation");
      const denied = contributionsOf(board, bounds, round, target.pos, target.card);

      const deniedSelfContribution = denied.get(instanceId) ?? 0;
      if (deniedSelfContribution !== 0) {
        // The point effect first, then its cancellation right below it -- so the
        // breakdown reads "here's what its own rule would have been worth, here's why
        // it didn't count" in that order, instead of only ever showing the already-net
        // result with nothing to compare it against. "external"/no sourceInstanceId (not
        // "self", and not the negator's id) on purpose: ownValueFor/disruptionFor in
        // lib/playtest/cardStats.ts scan breakdown entries by source/sourceInstanceId to
        // attribute real stats, and this line is neither a genuine self-earned point nor
        // a real disruption event to credit to the negator -- just an explanatory mirror
        // of the "Negated by" line right after it. Both informational: the real total is
        // always exactly base for a negated card (see resolveBoard), these two lines
        // exist purely to make the denial visible/attributable.
        push(instanceId, deniedSelfContribution, "Own rule (negated)", "external", undefined, true);
        const share = deniedSelfContribution / negatorIds.length;
        for (const negatorId of negatorIds) push(instanceId, -share, `Negated by ${negatorName(negatorId)}`, "external", negatorId, true);
      }

      // Negation also cancels the target's OUTGOING effects on its own neighbors --
      // those addDelta calls simply never happen (the source's whole hook is skipped),
      // which otherwise leaves zero trace anywhere: not on the neighbor (nothing ever
      // ran), not on the negated card (its own breakdown only ever explained its SELF
      // portion above). Same visible/attributable treatment, just landing on the
      // neighbor's breakdown instead, since the neighbor is who actually lost out.
      for (const [otherInstanceId, amount] of denied) {
        if (otherInstanceId === instanceId || amount === 0) continue;
        push(otherInstanceId, amount, `Would have received from ${CARD_DEFS[target.card.cardId].name} (negated)`, "external", undefined, true);
        const share = amount / negatorIds.length;
        for (const negatorId of negatorIds) push(otherInstanceId, -share, `Denied by ${negatorName(negatorId)}`, "external", negatorId, true);
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
  originalBoard: Board,
  bounds: BoardBounds,
  round: number,
  centerEffect: CenterEffectId = "none",
  playerIds?: string[]
): ResolutionResult {
  // Every downstream pass (suppression, valueModifiers, base lookups, center effects)
  // runs against `board`, the fully-swapped copy -- resolution proceeds exactly as if
  // every Facestealer swap genuinely happened, for every card's purposes, not just the
  // swapped card's own. `originalBoard` is consulted again below only to recover each
  // instance's *real* cardId for display (see the cards.push loop) -- see
  // applyIdentitySwaps' own doc comment for the full reasoning.
  const { swaps, thievesOf } = computeIdentitySwaps(originalBoard, bounds);
  const board = applyIdentitySwaps(originalBoard, swaps);

  const negatorsOf = computeNegatorsOf(board, bounds);
  const negated = new Set(negatorsOf.keys());
  const contributions = computeValueModifiers(board, bounds, round, negated, negatorsOf, centerEffect);

  // `informational` entries (currently just negation's "here's what got cancelled"
  // lines -- see computeValueModifiers) explain something in the breakdown/disruption
  // tally but never count toward the card's own value -- a negated card's real total
  // is always exactly its base, full stop.
  const values = new Map<string, number>();
  for (const c of board.values()) {
    const rawTotal = CARD_DEFS[c.cardId].base + (contributions.get(c.instanceId) ?? []).reduce((sum, d) => sum + (d.informational ? 0 : d.amount), 0);
    values.set(c.instanceId, rawTotal);
  }

  applyFloors(board, values);

  const cards: ResolvedCard[] = [];
  const totalsByOwner: Record<string, number> = {};
  if (playerIds) for (const id of playerIds) totalsByOwner[id] = 0;

  // For the top-of-breakdown "Negated by X" caption below -- needs each negator's
  // display name off its instanceId, same lookup computeValueModifiers builds
  // internally for its own "Negated by" lines, just needed again out here.
  const cardNameByInstanceId = new Map<string, string>();
  for (const c2 of board.values()) cardNameByInstanceId.set(c2.instanceId, CARD_DEFS[c2.cardId].name);

  for (const [key, c] of board.entries()) {
    const swap = swaps.get(c.instanceId);
    // `base`/`cardContributions`/`finalValue` all come from `c`, the swapped card --
    // that's what actually got scored. The displayed `cardId` below instead comes from
    // `swap.originalCardId` (real identity) when this instance swapped, so the board,
    // card art, and stats tracking all show what was actually placed.
    const base = CARD_DEFS[c.cardId].base;
    const cardContributions = contributions.get(c.instanceId) ?? [];
    const finalValue = values.get(c.instanceId) ?? base;

    const breakdown: ScoreContribution[] = [];
    if (negated.has(c.instanceId)) {
      // The single most important fact about a negated card's breakdown, so it goes
      // first, above even the swap caption/Base -- a reader shouldn't have to scan
      // past several other lines to learn a card's own rule never fired at all. The
      // detailed point-effect-then-cancellation pair (see computeValueModifiers) is
      // still further down in cardContributions; this is just the headline. Multiple
      // negators (rare -- a card boxed in by two at once) are all named, joined.
      const negatorNames = (negatorsOf.get(c.instanceId) ?? []).map((id) => cardNameByInstanceId.get(id) ?? "negation");
      breakdown.push({ label: `Negated by ${negatorNames.join(", ")}`, amount: 0, source: "self" });
    }
    if (swap) {
      // Legible post-game annotation for why this card's own numbers don't match its
      // printed rule -- see computeIdentitySwaps. Placed before "Base" (not after) so
      // it reads as the reason the base/rule below is what it is, not an afterthought.
      // Zero-amount: the swap's real effect is already baked into `base` and
      // `cardContributions` below, this line just explains why.
      const label =
        swap.originalCardId === "Infiltrator"
          ? `Scoring as ${CARD_DEFS[swap.newCardId].name} (Facestealer effect)`
          : `Scoring as ${CARD_DEFS.Infiltrator.name} (Facestealer effect)`;
      breakdown.push({ label, amount: 0, source: "self" });

      // If this instance LOST its identity (it's the target, not the thief), its true
      // self-worth as its real identity is otherwise invisible: the swap changes
      // `cardId` directly rather than going through addDelta, so nothing in
      // computeValueModifiers ever attributes the loss to the Facestealer(s)
      // responsible. Recovered the same way negation recovers a denied effect --
      // running the (true, unswapped) identity's own hook in isolation against the
      // current board -- and split evenly across every thief that targeted this card
      // (see computeIdentitySwaps' thievesOf), same "share it" convention negation
      // uses for multiple negators. Both informational: net to 0, doesn't touch
      // finalValue, only makes the theft visible/attributable.
      if (swap.originalCardId !== "Infiltrator") {
        const trueSelfContribution = contributionsOf(board, bounds, round, parsePosKey(key), { ...c, cardId: swap.originalCardId }).get(c.instanceId) ?? 0;
        const stolen = CARD_DEFS[swap.originalCardId].base + trueSelfContribution - base;
        const thieves = thievesOf.get(c.instanceId) ?? [];
        if (stolen !== 0 && thieves.length > 0) {
          breakdown.push({ label: `True value as ${CARD_DEFS[swap.originalCardId].name}`, amount: stolen, source: "self", informational: true });
          const share = stolen / thieves.length;
          for (const thiefId of thieves) {
            breakdown.push({ label: "Stolen by Facestealer", amount: -share, source: "external", sourceInstanceId: thiefId, informational: true });
          }
        }
      }
    }
    breakdown.push({ label: "Base", amount: base, source: "self" });
    breakdown.push(...cardContributions);
    const rawTotal = base + cardContributions.reduce((sum, d) => sum + (d.informational ? 0 : d.amount), 0);
    if (finalValue !== rawTotal) {
      // The card's own printed floor rule, not something a neighbor did.
      breakdown.push({ label: FLOORED_AT_ZERO_LABEL, amount: finalValue - rawTotal, source: "self" });
    }

    cards.push({
      instanceId: c.instanceId,
      cardId: swap ? swap.originalCardId : c.cardId,
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
    kingslayerHit: postResult?.kingslayerHit ?? [],
  };
}
