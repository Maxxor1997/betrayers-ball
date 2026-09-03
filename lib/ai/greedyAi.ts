import { adjacentPositions, getAdjacentCards, isOwnerlessPosition, parsePosKey, posKey } from "../engine/board";
import { CARD_DEFS, copiesForPlayerCount } from "../content/cards";
import { computeAiVote, estimateMargin } from "../engine/endgame";
import { redactedBoardFor } from "../engine/playerView";
import { resolveBoard } from "../engine/resolution";
import { applyPlace, currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, offeredCardsFor } from "../engine/turns";
import { Board, BoardBounds, CardId, CardInstance, GameAction, GameConfig, GameState, Position } from "../engine/types";

export type Rng = () => number;

/** Picks the highest-scoring option, breaking ties randomly. */
function pickBest<T>(options: T[], score: (option: T) => number, rng: Rng): T {
  let best: T[] = [];
  let bestScore = -Infinity;
  for (const option of options) {
    const s = score(option);
    if (s > bestScore) {
      bestScore = s;
      best = [option];
    } else if (s === bestScore) {
      best.push(option);
    }
  }
  return best[Math.floor(rng() * best.length)];
}

/**
 * Baseline chance of flipping an opponent's card speculatively, when no own-card flip
 * is worth it -- see the note in chooseFlip on why this can't be value-ranked. Still
 * high, not 50/50: only Gloryseeker clearly wants to stay hidden for its owner (+3
 * face-up), and it's a small slice of the deck, so a blind flip is still usually a
 * free look. But it's not *zero* risk either -- flipping a hidden card that happens to
 * be an opponent's Gloryseeker hands them a free +3, so this is nudged down a bit
 * from a flat "always grab the free look" to reflect that real downside instead of
 * ignoring it entirely.
 */
const OPPONENT_FLIP_EXPLORATION_PROBABILITY = 0.75;

function hypotheticalFlipMargin(state: GameState, playerId: string, target: { instanceId: string }): number {
  const board = new Map(state.board);
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  board.set(entry[0], { ...entry[1], faceUp: true });
  return estimateMargin({ ...state, board }, playerId);
}

/**
 * Manhattan distance from `target` to the nearest of the AI's own cards, negated so
 * higher (closer to 0) ranks better -- used to rank blind opponent flip targets. The
 * AI can't know an opponent's hidden identity before flipping, but a card touching (or
 * near) its own board presence is still worth more to reveal than one off in a corner:
 * several of the AI's cards (Berserker, Mercenary, Commander, Bannerman...) score off a
 * neighbor's or the board's true identity, and those evaluations stay blind to a hidden
 * card nearby until it's flipped. A neighbor (distance 1) is the closest a non-own
 * card can be, so it naturally ranks first; ties -- including "no own cards yet" --
 * fall back to pickBest's random tiebreak.
 */
function opponentTargetPriority(board: GameState["board"], playerId: string, target: CardInstance): number {
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  const pos = parsePosKey(entry[0]);
  let nearestOwnDistance = Infinity;
  for (const [key, c] of board.entries()) {
    if (c.ownerId !== playerId) continue;
    const otherPos = parsePosKey(key);
    const distance = Math.abs(otherPos.x - pos.x) + Math.abs(otherPos.y - pos.y);
    if (distance < nearestOwnDistance) nearestOwnDistance = distance;
  }
  return -nearestOwnDistance;
}

/**
 * Extra priority for a blind opponent flip target from any Truthseeker/Nightjar
 * neighbor whose owner is actually known -- either the flipper's own card (always
 * known, even face-down) or a revealed face-up card, the same honest info
 * estimateMargin itself is limited to. Flipping the target face-up has a real,
 * certain consequence for each such neighbor even though the target's own identity
 * stays unknown until it's flipped:
 * - An adjacent Truthseeker is currently dealing the target -2 for being face-down
 *   (see lib/content/cards.ts) -- flipping removes that, which only ever helps the
 *   target's owner (an opponent), so it's discouraged regardless of who owns the
 *   Truthseeker.
 * - An adjacent Nightjar (cardId "Beacon") gains +1 per adjacent card that *matches
 *   its own* face-up/down state, not simply "+1 per face-up neighbor" anymore -- so
 *   flipping the target face-up only helps a Nightjar that's ALSO face-up (a new
 *   match forms) and actually HURTS one that's face-down (breaks an existing
 *   face-down/face-down match). The sign here tracks the Nightjar's own `faceUp`,
 *   then flips again if it belongs to an opponent rather than the flipper.
 */
function truthseekerBeaconFlipAdjustment(board: Board, bounds: BoardBounds, playerId: string, target: CardInstance): number {
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  const pos = parsePosKey(entry[0]);
  let adjustment = 0;
  for (const n of getAdjacentCards(board, bounds, pos)) {
    const identityKnown = n.ownerId === playerId || n.faceUp;
    if (!identityKnown) continue;
    if (n.cardId === "Truthseeker") adjustment -= 2;
    else if (n.cardId === "Beacon") {
      const gainForOwner = n.faceUp ? 1 : -1;
      adjustment += n.ownerId === playerId ? gainForOwner : -gainForOwner;
    }
  }
  return adjustment;
}

/**
 * Extra priority for a blind opponent flip target adjacent to one of the flipper's own
 * face-up cards, scaled by that neighbor's base value. A face-down opponent card
 * sitting next to a valuable face-up card of ours is a live threat -- it might BE a
 * Facestealer waiting to swap into that neighbor's whole identity at scoring (it
 * always targets the highest-*base* adjacent face-up card -- see lib/content/cards.ts
 * -- so this scan by base value is still the right proxy for "how tempting a target is
 * this"), and flipping it face-up is the counter (a face-up Facestealer's swap never
 * fires at all -- resolution.ts's identity-swap pass only ever considers face-down
 * ones). The AI can't know the target's identity before flipping, so this can't be
 * certain -- just a heuristic nudge toward defending whatever's most worth protecting,
 * on top of opponentTargetPriority's plain adjacency signal. This weight predates
 * Facestealer's rework from a resolved-value swap into a full identity swap -- the
 * underlying logic (defend valuable face-up neighbors) still applies unchanged, but
 * the magnitude was never re-validated against the new mechanic's real stakes.
 */
const INFILTRATOR_DEFENSE_WEIGHT_PER_BASE = 0.15;

function infiltratorDefenseAdjustment(board: Board, bounds: BoardBounds, playerId: string, target: CardInstance): number {
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  const pos = parsePosKey(entry[0]);
  let atRiskValue = 0;
  for (const n of getAdjacentCards(board, bounds, pos)) {
    if (n.ownerId === playerId && n.faceUp) atRiskValue += CARD_DEFS[n.cardId].base;
  }
  return atRiskValue * INFILTRATOR_DEFENSE_WEIGHT_PER_BASE;
}

/**
 * Downweight (not certainty -- see infiltratorDefenseAdjustment's doc comment for why
 * this can't be exact either) for a blind opponent flip target sitting next to one or
 * more of the flipper's own face-up cards: if the hidden target turns out to be a
 * Doomherald (see lib/content/cards.ts), flipping it deals -3 to every one of its
 * neighbors, including those same face-up cards of ours. Same neighbor scan as
 * infiltratorDefenseAdjustment (deliberately -- an unknown target next to our own
 * valuable stuff is simultaneously a defensive reason to flip it, if it's an
 * Infiltrator staged to steal that value, and a risk reason not to, if it's a
 * Doomherald staged to blast it), just the opposite sign and its own weight so the two
 * can be tuned independently. Deliberately smaller in magnitude than
 * INFILTRATOR_DEFENSE_WEIGHT_PER_BASE (not equal, which would cancel it out entirely)
 * -- kept subordinate to that older, more battle-tested signal, but neither weight has
 * real playtest validation behind its current number right now: Facestealer's own
 * weight predates its rework into a full identity swap (see that constant's own doc
 * comment), and Doomherald's was never calibrated to begin with. Both are starting
 * priors pending real data.
 */
const DOOMHERALD_RISK_WEIGHT_PER_BASE = 0.075;

function doomheraldRiskAdjustment(board: Board, bounds: BoardBounds, playerId: string, target: CardInstance): number {
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  const pos = parsePosKey(entry[0]);
  let atRiskValue = 0;
  for (const n of getAdjacentCards(board, bounds, pos)) {
    if (n.ownerId === playerId && n.faceUp) atRiskValue += CARD_DEFS[n.cardId].base;
  }
  return -atRiskValue * DOOMHERALD_RISK_WEIGHT_PER_BASE;
}

/**
 * Nudges the flat opponent-flip exploration rate based on the flipper's own hand --
 * a face-down card still in hand isn't on the board yet, so this can't target a
 * specific placement, just lean the overall willingness to explore. Holding a
 * Truthseeker means face-down opponent cards are worth more left alone (future
 * targets for its -2/face-down-neighbor once placed), so exploring less preserves
 * them.
 *
 * There used to be a mirror-image HAND_BEACON_EXPLORATION_BONUS here ("holding a
 * Beacon means face-up cards are worth more existing in general, so explore more to
 * grow that pool"), removed once Beacon (now "Nightjar") was reworked to key off
 * matching its *own* face-up/down state instead of unconditionally wanting more
 * face-up neighbors -- see lib/content/cards.ts. Whether more face-up cards on the
 * board helps a given Nightjar now depends entirely on what face state it (and its
 * owner's own future flip choices) end up in, which isn't knowable from hand alone,
 * so there's no longer a clean, honest directional lean to nudge exploration by.
 */
const HAND_TRUTHSEEKER_EXPLORATION_DISCOUNT = 0.15;

/**
 * Further discount on the exploration rate when the AI has a face-down Infiltrator at
 * stake -- either already on the board, or still in hand (a future placement, same
 * as the Truthseeker/Beacon hand nudges above). Infiltrator's entire value depends on
 * staying face-down until scoring (once face-up, resolution.ts's identity-swap pass
 * skips it entirely -- see lib/content/cards.ts), and every flip this AI initiates is a small
 * push toward a more flip-happy table overall, raising the odds someone eventually
 * flips this AI's own Infiltrator back. Not a direct mechanical consequence like
 * Truthseeker/Beacon's adjacency effects (there's no real causal link from "I flipped
 * their card" to "someone flips mine"), just a self-preservation lean: don't go
 * looking for trouble when protecting a hidden card matters.
 */
const INFILTRATOR_EXPLORATION_DISCOUNT = 0.15;

/**
 * Flat discount on the exploration rate whenever Doomherald has any copies in this
 * game's deck at all -- unlike the Truthseeker/Beacon/Infiltrator nudges above (which
 * only fire when the AI's own hand or board happens to hold the relevant card),
 * this one doesn't depend on knowing anything hidden: deck composition
 * (copiesForPlayerCount) is public, known to every player, even though which specific
 * face-down card is a Doomherald never is. Without this, doomheraldRiskAdjustment
 * alone only ever reshuffles *which* target gets picked once the AI has already
 * committed to exploring -- it has no way to make the AI warier of exploring *at all*,
 * so Doomherald existing in the deck wouldn't move the population-wide flip rate even
 * a little, which defeats the point of a card meant to make blind flipping feel
 * risky. This is the "there's a landmine somewhere out there" caution that
 * doomheraldRiskAdjustment structurally can't express on its own.
 */
const DOOMHERALD_DECK_PRESENCE_EXPLORATION_DISCOUNT = 0.1;

/**
 * Rough expected round the game actually ends on. game.ts's config keeps roundCap and
 * minRoundFloor flat regardless of player count (6 and 2 respectively, see
 * configForPlayerCount), so the midpoint doesn't need to vary by player count either
 * -- it's not meant to be precise, just a stand-in "how much game is probably left"
 * for heuristics below that need to reason about rounds that haven't happened yet.
 */
function expectedFinalRound(config: GameConfig): number {
  return (config.minRoundFloor + config.roundCap) / 2;
}

/**
 * Expected number of *additional copies* of `cardId` that will land on the board by
 * game's end, given only what's actually knowable. Shared by both Berserker
 * ("Hydra", +2 per other copy) and Warlord (−2 per other copy) -- both now count
 * every OTHER matching card straight off `board.values()`, any owner including the
 * player's own, no `faceUp` check (see cards.ts) -- so flipping either changes
 * nothing about the owner's own margin (hypotheticalFlipMargin always comes back
 * equal to baseline for them). The two cards' *use* of this estimate is opposite (see
 * berserkerFlipBaitBonus / warlordFlipDeterrenceBonus and their
 * placementHeuristicAdjustment cases): Berserker starts weak and wants more copies in
 * play (a reason to bait), Warlord starts strong and wants no more copies showing up
 * (a reason to deter, and a reason to discount its own placement value for the risk
 * that one will anyway) -- but "how many new copies should I expect" is the identical
 * question underneath either way.
 *
 * Unlike the old unique-owner rule this replaced, every additional copy counts on its
 * own now -- there's no owner to dedup by, including the player's own not-yet-placed
 * copies (a card no longer only matters once some OTHER player plays a rival one).
 * That collapses the model from "per-opponent probability of at least one" down to a
 * single pooled expectation, which is actually simpler:
 * - `hidden` = copies of `cardId` not yet on the board anywhere (deck composition is
 *   public via copiesForPlayerCount, so this is exact -- total copies minus every
 *   copy already placed, any owner, any face state).
 * - Every player's remaining hand slot (including `playerId`'s own -- a copy still in
 *   your own hand is just as much a "future copy" now as one in an opponent's) is one
 *   more independent draw that might turn out to be a hidden copy of `cardId`.
 *   `perDrawRate` = hidden / (combined remaining hand size of every player) is the
 *   chance any single such draw is a copy -- deliberately not assuming anyone is
 *   especially likely or unlikely to prioritize this particular card.
 * - `totalDraws` sums, across every player, how many of their own remaining turns
 *   will actually happen (capped by both roundsRemaining and their own hand size).
 * - By linearity of expectation, the expected number of hits across `totalDraws`
 *   independent `perDrawRate` trials is just `perDrawRate * totalDraws` -- no
 *   saturating "1 - (1-p)^k" needed anymore, since that shape was only for "at least
 *   one hit from a specific opponent," not a plain expected count.
 * - `rateMultiplier` scales `perDrawRate` -- see berserkerFlipBaitBonus (>1, a boost)
 *   and warlordFlipDeterrenceBonus (<1, a suppression), the two places this isn't left
 *   at 1: flipping your own copy face-up is modeled as moving how eagerly the rest of
 *   the table matches it going forward, in whichever direction that card actually
 *   wants. Applying it across the whole pooled rate (including the player's own
 *   future draws) is an approximation -- seeing your own flip doesn't really change
 *   your own future decisions the way it changes opponents' -- but splitting that out
 *   is a finer-grained behavioral correction than this batch's scope covers.
 */
function expectedNewCopiesOf(state: GameState, cardId: CardId, rateMultiplier = 1): number {
  const totalCopies = copiesForPlayerCount(CARD_DEFS[cardId], state.config.playerCount);
  const onBoard = [...state.board.values()].filter((c) => c.cardId === cardId).length;
  const hidden = Math.max(0, totalCopies - onBoard);
  if (hidden === 0) return 0;

  const roundsRemaining = Math.max(0, expectedFinalRound(state.config) - state.round);
  let totalHandCards = 0;
  let totalDraws = 0;
  for (const p of state.players) {
    totalHandCards += p.hand.length;
    totalDraws += Math.min(roundsRemaining, p.hand.length);
  }
  if (totalHandCards === 0) return 0;

  const perDrawRate = Math.min(1, (hidden / totalHandCards) * rateMultiplier);
  return Math.min(hidden, perDrawRate * totalDraws);
}

/**
 * Modeled bump to how eagerly opponents match a Berserker once it's visible -- not a
 * proven/calibrated number (no real playtest signal on this specific number yet, same
 * caveat as several other fresh constants in this file), just a reasonable prior that
 * seeing a live rival Berserker meaningfully raises the odds someone matches it,
 * versus it staying a private, unconfirmed rumor while face-down.
 */
const BERSERKER_FACEUP_BAIT_MULTIPLIER = 1.5;

/**
 * The real reason to flip your own Berserker: not its own margin (flipping doesn't
 * change its value at all -- see expectedNewCopiesOf's doc comment), but the future
 * value of baiting the rest of the table into matching it sooner. Computed as the
 * *incremental* expected-new-copies from assuming a boosted match rate once visible
 * versus the baseline (still-hidden) rate, each worth +2 once realized. Folded
 * directly into chooseFlip's own-target margin-ranked loop (not a flat-chance
 * fallback), so it can win the flip decision on its own principled merit -- competing
 * fairly against, say, a Gloryseeker that's a clearly better flip this particular
 * turn -- rather than only ever firing via an unconditional dice roll.
 */
function berserkerFlipBaitBonus(state: GameState, target: { cardId: CardId }): number {
  if (target.cardId !== "Berserker") return 0;
  const baseline = expectedNewCopiesOf(state, "Berserker", 1);
  const boosted = expectedNewCopiesOf(state, "Berserker", BERSERKER_FACEUP_BAIT_MULTIPLIER);
  return 2 * (boosted - baseline);
}

/**
 * Modeled dip in how eagerly the rest of the table matches a Warlord once yours is
 * visible -- the mirror image of BERSERKER_FACEUP_BAIT_MULTIPLIER, and just as
 * unproven/uncalibrated. Unlike Berserker, another copy landing on the board always
 * costs its owner too (the symmetric −2-per-other-copy penalty applies to them as
 * well, including your own future copies -- see cards.ts) -- so revealing yours isn't
 * bait, it's closer to a public "there's no upside in matching this" signal. Kept
 * below 1 (a suppression), not above.
 */
const WARLORD_FACEUP_DETERRENCE_MULTIPLIER = 0.5;

/**
 * The real reason to flip your own Warlord: not its own margin (flipping doesn't
 * change it -- same no-faceUp-check shape as Berserker), but the future value of
 * *deterring* new copies, since every other copy costs you −2. Computed as the
 * incremental expected-new-copies from assuming a suppressed match rate once visible
 * versus the baseline (still-hidden) rate -- each *avoided* copy is worth +2 (the
 * penalty you don't take), so this is positive exactly when revealing plausibly
 * reduces how many more copies end up on the board. Same "fold into the real
 * margin-ranked loop, not a flat-chance fallback" treatment as Berserker's bait bonus.
 */
function warlordFlipDeterrenceBonus(state: GameState, target: { cardId: CardId }): number {
  if (target.cardId !== "Warlord") return 0;
  const baseline = expectedNewCopiesOf(state, "Warlord", 1);
  const deterred = expectedNewCopiesOf(state, "Warlord", WARLORD_FACEUP_DETERRENCE_MULTIPLIER);
  return 2 * (baseline - deterred);
}

/**
 * Own-flip candidates only preempt the blind opponent-flip search below when their
 * edge over baseline is a clean, decisive one -- not just noise. Gloryseeker/Chronicler
 * are the two cards whose value depends most directly on self.faceUp, but both are
 * opponentOnlyFlip and so never appear as an own target at all. Nightjar (cardId
 * "Beacon") is the clearest remaining own-target card with a *real* direct self-value
 * dependency (it keys off matching its own face-up/down state against its neighbors --
 * see lib/content/cards.ts) -- flipping your own face-down Nightjar can swing its value
 * by more than this secondary noise all on its own, and hypotheticalFlipMargin already
 * captures that correctly since it's a real engine simulation, not a special-cased
 * shortcut. Earthshaker is the same shape now too (its −2-to-connected-row/col is also
 * gated on self.faceUp -- see lib/content/cards.ts): the swing there lands on its
 * *neighbors*, not its own value, but hypotheticalFlipMargin nets that into the same
 * fair margin either way, so it's caught by this branch exactly the same. Every *other*
 * own-target card has zero direct self-value dependency, so for those, before
 * expectedHiddenNeighborAdjustments existed, hypotheticalFlipMargin's delta was always
 * exactly 0 and this branch never fired. Now every own flip gets a small secondary
 * "defensive" delta too (revealing a card removes its exposure to a hypothetical hidden
 * face-down-only threat like Truthseeker -- see estimateMargin) -- real, but small, and
 * it shouldn't be enough on its own to skip a potentially much more valuable blind
 * opponent flip. 1 matches the smallest single printed-effect magnitude in the deck
 * (e.g. Footman's own +1, Nightjar's +1/matching neighbor), so a gain at or above it
 * reads as a genuine, decisive edge rather than this secondary noise.
 */
const OWN_FLIP_MIN_EDGE = 1;

/**
 * Flips the target that improves the (fair) margin the most -- but only among the
 * player's own face-down cards, which they already know the identity of, so ranking
 * them by true post-flip value is fair. An opponent's face-down cards can't be ranked
 * this way without peeking (their true post-flip value literally requires knowing
 * their hidden identity first) -- so a flip target there, if any, is chosen instead of
 * a value-driven one, blind, weighted toward targets adjacent to the AI's own cards
 * (any known Truthseeker/Beacon neighbor, see truthseekerBeaconFlipAdjustment; extra
 * weight for threatening a valuable face-up card of ours, see
 * infiltratorDefenseAdjustment; extra caution near our own face-up cards, see
 * doomheraldRiskAdjustment), at an exploration rate nudged by the AI's own hand and
 * board (see HAND_TRUTHSEEKER_EXPLORATION_DISCOUNT/INFILTRATOR_EXPLORATION_DISCOUNT)
 * and by public deck knowledge (see DOOMHERALD_DECK_PRESENCE_EXPLORATION_DISCOUNT).
 */
function chooseFlip(state: GameState, playerId: string, rng: Rng): string | null {
  const targets = getLegalFlipTargets(state);
  if (targets.length === 0) return null;

  const ownTargets = targets.filter((t) => t.ownerId === playerId);
  const opponentTargets = targets.filter((t) => t.ownerId !== playerId);

  const baseline = estimateMargin(state, playerId);
  let bestOwnTargets: string[] = [];
  let bestOwnScore = baseline;

  for (const target of ownTargets) {
    const score =
      hypotheticalFlipMargin(state, playerId, target) + berserkerFlipBaitBonus(state, target) + warlordFlipDeterrenceBonus(state, target);
    if (score > bestOwnScore) {
      bestOwnScore = score;
      bestOwnTargets = [target.instanceId];
    } else if (score === bestOwnScore && score > baseline) {
      bestOwnTargets.push(target.instanceId);
    }
  }

  if (bestOwnTargets.length > 0 && bestOwnScore - baseline >= OWN_FLIP_MIN_EDGE) {
    return bestOwnTargets[Math.floor(rng() * bestOwnTargets.length)];
  }

  if (opponentTargets.length > 0) {
    const hand = state.players.find((p) => p.id === playerId)!.hand;
    const hasVulnerableInfiltrator =
      hand.some((c) => c.cardId === "Infiltrator") ||
      [...state.board.values()].some((c) => c.ownerId === playerId && c.cardId === "Infiltrator" && !c.faceUp);
    let explorationProbability = OPPONENT_FLIP_EXPLORATION_PROBABILITY;
    if (hand.some((c) => c.cardId === "Truthseeker")) explorationProbability -= HAND_TRUTHSEEKER_EXPLORATION_DISCOUNT;
    if (hasVulnerableInfiltrator) explorationProbability -= INFILTRATOR_EXPLORATION_DISCOUNT;
    if (copiesForPlayerCount(CARD_DEFS.Chronicler, state.config.playerCount) > 0) {
      explorationProbability -= DOOMHERALD_DECK_PRESENCE_EXPLORATION_DISCOUNT;
    }
    explorationProbability = Math.min(1, Math.max(0, explorationProbability));

    if (rng() < explorationProbability) {
      const best = pickBest(
        opponentTargets,
        (target) =>
          opponentTargetPriority(state.board, playerId, target) +
          truthseekerBeaconFlipAdjustment(state.board, state.config.boardBounds, playerId, target) +
          infiltratorDefenseAdjustment(state.board, state.config.boardBounds, playerId, target) +
          doomheraldRiskAdjustment(state.board, state.config.boardBounds, playerId, target),
        rng
      );
      return best.instanceId;
    }
  }

  return null;
}

/**
 * One flip target's heuristic worth, as a single comparable number for shortlisting
 * which targets get a real simulated sample (see hardFast.ts's rankedFlipCandidates)
 * -- deliberately NOT the same scoring chooseFlip itself uses. chooseFlip has no
 * simulation to fall back on, so its own inline scoring leans on several card-specific
 * guesses (hypotheticalFlipMargin plus Berserker/Warlord bait/deterrence bonuses for
 * own targets; opponentTargetPriority plus Truthseeker/Infiltrator/Doomherald
 * adjustments for opponent targets) to approximate risk and reward it has no other way
 * to see. A real simulated sample doesn't have that limitation: whatever card
 * determinize actually reveals gets resolved for real by trueValues, so any effect --
 * Doomherald punishing a neighbor, Facestealer stealing a newly-eligible face-up
 * neighbor, anything else -- is already honestly priced into the average once a
 * candidate is simulated at all. Baking chooseFlip's own one-directional guesses into
 * the SHORTLIST on top of that doesn't add real signal (the simulation already sees
 * the full picture, not just the one direction each heuristic happens to know about)
 * -- it just risks crowding out a candidate the simulation would have judged
 * correctly, purely because a heuristic tuned for a different card guessed wrong.
 *
 * So this keeps only the generic, non-card-specific piece of each branch: an own
 * target's real margin estimate (hypotheticalFlipMargin -- still a genuine value
 * computed from the true engine) and an opponent target's plain proximity signal
 * (opponentTargetPriority) -- plus one deliberate exception (see
 * SPECULATIVE_OWN_FLIP_WEIGHT below).
 *
 * Warlord/Berserker's bait/deterrence rationale can never be validated by a real
 * simulated sample (no simulated agent here reacts to a revealed card, so their real
 * average always comes back ~0 same as hypotheticalFlipMargin alone would show) --
 * but that's an argument for not trusting it as real value, not for excluding it from
 * ever being TRIED. Without any nudge at all, they'd score identically to any other
 * card with genuinely nothing to gain from flipping (e.g. a plain Footman with no
 * face-state-dependent effect at all), and lose ties to those arbitrarily. A small
 * fraction of the real bait/deterrence estimate (SPECULATIVE_OWN_FLIP_WEIGHT) breaks
 * that tie in their favor -- enough to make them a real candidate ahead of targets
 * with no upside whatsoever, nowhere near enough to compete with a target whose
 * hypotheticalFlipMargin shows genuine, engine-computed value.
 *
 * Own-target scores are genuine margin deltas (comparable to 0 = "flipping this is
 * worse than not flipping at all"). Opponent-target scores are a plain priority
 * heuristic, not a margin estimate, so it is not directly comparable in scale to an
 * own-target score -- a caller ranking across both pools needs to account for that
 * (see rankedFlipCandidates's own doc comment for how it handles this by never
 * merging them into one sort).
 */
const SPECULATIVE_OWN_FLIP_WEIGHT = 0.2;

export function flipCandidateScore(state: GameState, playerId: string, target: CardInstance): number {
  if (target.ownerId === playerId) {
    const speculative = berserkerFlipBaitBonus(state, target) + warlordFlipDeterrenceBonus(state, target);
    return hypotheticalFlipMargin(state, playerId, target) + SPECULATIVE_OWN_FLIP_WEIGHT * speculative;
  }
  return opponentTargetPriority(state.board, playerId, target);
}

/** Empty (unoccupied, non-ownerless) cells orthogonally adjacent to `pos` -- candidate spots a future placement could still fill in before scoring. */
function countEmptyAdjacentCells(board: Board, bounds: BoardBounds, pos: Position): number {
  return adjacentPositions(pos, bounds).filter((p) => !isOwnerlessPosition(p, bounds) && !board.has(posKey(p))).length;
}

/** Rough fraction of a currently-empty neighbor cell expected to fill in per remaining round, for Exile's future-neighbor discount below. Not derived from anything -- a modest, clearly-bounded playtesting estimate. */
const EXILE_NEIGHBOR_FILL_RATE_PER_ROUND = 0.4;

/** Value credited per Footman still in the player's own hand when considering a Commander placement -- a fraction (not the full weight=1 this used to sit at) of the full +2 adjacency bonus, since orthogonal adjacency caps a Commander at 4 neighbors total and there's no guarantee any given hand Footman ever actually lands next to this specific Commander instead of somewhere else on the board -- crediting the full +2 systematically overvalued Commander relative to how rarely it actually realizes more than one or two adjacent Footmen in practice (see the playtest "Own Δ base" data). */
const COMMANDER_HAND_FOOTMAN_WEIGHT = 0.4;
/** Flat per-remaining-round nudge for Commander, on top of any hand-Footman credit -- more turns left means more chances to draw and set up a Footman next to it even with none in hand yet. */
const COMMANDER_EARLY_GAME_BONUS_PER_ROUND = 0.5;

/**
 * Rough chance, per *opponent turn* once flips are actually unlocked, that a given
 * opponent's blind exploration flip (see OPPONENT_FLIP_EXPLORATION_PROBABILITY /
 * opponentTargetPriority) lands on this specific face-down Gloryseeker rather than
 * some other face-down card. Gloryseeker is `opponentOnlyFlip` (see
 * lib/content/cards.ts) -- its own owner can never flip it, so this is purely the
 * chance *an opponent* bothers to; it doesn't depend on the card's own +4/+3/whatever
 * magnitude, since opponent flip targets are chosen blind, not by value.
 *
 * This is per opponent *turn*, not per round, on purpose: a round only advances once
 * every player has taken a turn (see advanceTurn in game.ts), so an 8p round packs in
 * 8 individual flip-attempt opportunities while a 2p round only has 2 -- a flat
 * per-round rate misses that entirely and badly underestimates at high player counts.
 * See GLORYSEEKER_FLIP_CHANCE below for how this combines across opponents and rounds.
 * Calibrated off the cleanest signal available -- 2p, where there's only ever one
 * possible flipper -- where played Gloryseekers convert ~40%; 3p-8p data (own Δ base
 * plateauing around +2.0 of +3, i.e. ~67%) is consistent with the same per-turn rate
 * scaled up by opponent count, once you account for that population average also
 * blending in later, more time-starved placements that never had this much of a
 * window to begin with.
 */
const GLORYSEEKER_FLIP_CHANCE_PER_OPPONENT_TURN = 0.18;

/**
 * Rough chance, per *opponent turn* once flips are actually unlocked, that a given
 * opponent's blind exploration flip lands on this specific face-down Doomherald rather
 * than some other face-down card. Doomherald is also `opponentOnlyFlip` (see
 * lib/content/cards.ts) -- same shape as Gloryseeker's own rate above (a random blind
 * target from the same shared pool), so this starts at the same value pending its own
 * playtest calibration once real games/sims have actually been run with it -- it isn't
 * expected to land exactly on Gloryseeker's number long-term, just a reasonable prior
 * to start from rather than an uncalibrated guess out of nowhere.
 */
const DOOMHERALD_FLIP_CHANCE_PER_OPPONENT_TURN = 0.18;

/**
 * Rough chance, per *own future turn* once flips are actually unlocked, that
 * Earthshaker's owner deliberately flips it themselves. Unlike Gloryseeker/Doomherald
 * (both `opponentOnlyFlip`), Earthshaker's own owner is a legal flipper too -- and
 * unlike an opponent's blind exploration flip (a random guess among every hidden
 * card), the owner's own flip decision is NOT blind: chooseFlip's own-target branch
 * scores exactly this move via hypotheticalFlipMargin against the real board before
 * deciding, so "is flipping this worth it" is answered accurately, not guessed at.
 * That makes a deliberate self-flip meaningfully more likely per opportunity than a
 * random opponent stumbling onto one specific hidden card among many -- hence a
 * materially higher rate than GLORYSEEKER_FLIP_CHANCE_PER_OPPONENT_TURN, not the same
 * one. Still well under 1: even when flipping Earthshaker would help, chooseFlip only
 * ever takes its single best-scoring own target each turn, so a turn where some other
 * own card scores higher won't flip Earthshaker that turn even though it was "worth
 * it" in isolation. Not proven/calibrated against real playtest data yet -- a
 * reasonable starting prior, same caveat as Doomherald's own rate above.
 */
const EARTHSHAKER_SELF_FLIP_CHANCE_PER_OWN_TURN = 0.5;

/**
 * Combines a per-opponent-turn flip rate across every opponent-turn still available
 * before scoring, as "at least one of N independent attempts lands on it"
 * (1 - (1-p)^N) -- saturating, not linear, so it never overshoots 1 the way naively
 * multiplying opponentTurns * p would once N gets large at 8p. Shared by every
 * `opponentOnlyFlip` card's placement heuristic (Gloryseeker, Doomherald -- see their
 * own per-turn rate constants above) plus Facestealer's swap-risk term, since "some
 * opponent eventually takes a blind flip that happens to land here" is the same shape
 * of event for any of them -- `opponentTurns` is meant to come from
 * exactRemainingOpponentTurns below, not a hand-rolled estimate.
 */
function saturatingFlipChance(perOpponentTurnRate: number, opponentTurns: number): number {
  return 1 - (1 - perOpponentTurnRate) ** opponentTurns;
}

/**
 * Exact count of opponent turns remaining between `state` and the game's guaranteed
 * end (round `roundCap`, forced by shouldEndGame in game.ts's advanceTurn regardless
 * of how any vote goes), given exactly where in the current round `state` sits.
 * Replaces the old "average rounds remaining × opponent count" approximation the
 * flip-risk models above used to share (via expectedFinalRound's (minRoundFloor +
 * roundCap)/2 midpoint): that treated every seat identically regardless of turn
 * order, so a player one turn from a round boundary and a player who just started
 * their round both got the same estimate -- most visibly wrong exactly when it
 * matters most, the literal last turn of the game, which that averaged estimate
 * never actually reaches 0 for, even though the true risk there is exactly zero
 * (nobody left to take another turn at all).
 *
 * Deliberately ignores the *possibility* the game ends early via a passing vote
 * (available from minRoundFloor on) -- modeling that honestly would need a real
 * prediction of vote behavior (computeAiVote, unpredictable humans), which isn't
 * attempted here. This is the hard upper bound instead: "if the game runs all the
 * way to roundCap, how many opponent turns are actually left." Since an early vote
 * can only *shorten* the game, this can only ever overestimate real risk, never
 * underestimate it -- a conservative bound, not a new blind spot.
 */
function exactRemainingOpponentTurns(state: GameState): number {
  const { players, round, turnsThisRound, config } = state;
  const n = players.length;
  let total = 0;
  if (round >= config.flipUnlockRound) {
    // Opponents who haven't gone yet this round -- the current player's own turn
    // (the action being considered right now) isn't a flip risk to itself, so
    // neither side of this subtraction counts it.
    total += Math.max(0, n - 1 - turnsThisRound);
  }
  for (let r = round + 1; r <= config.roundCap; r++) {
    if (r >= config.flipUnlockRound) total += n - 1;
  }
  return total;
}

/**
 * Same idea and same conservative-upper-bound reasoning as exactRemainingOpponentTurns
 * above, but counting the acting player's own remaining turns instead -- exactly one
 * per future round (this game's turn structure gives every seat one turn per round),
 * from the round after this one through roundCap, counted only once flips are
 * unlocked. The current turn itself (the action being evaluated right now) is
 * deliberately excluded -- it's not a *future* opportunity to flip this placement,
 * it's the placement happening. Used by Earthshaker's self-flip credit above.
 */
function exactRemainingOwnTurns(state: GameState): number {
  const { round, config } = state;
  let total = 0;
  for (let r = round + 1; r <= config.roundCap; r++) {
    if (r >= config.flipUnlockRound) total += 1;
  }
  return total;
}

/**
 * Rough chance, per *opponent turn* once flips are actually unlocked, that a given
 * opponent's blind exploration flip lands on this specific face-down Facestealer --
 * same saturating shape as GLORYSEEKER_FLIP_CHANCE_PER_OPPONENT_TURN/
 * DOOMHERALD_FLIP_CHANCE_PER_OPPONENT_TURN above, but set a bit higher than either:
 * unlike those two (pure blind targets), a Facestealer sitting next to one of the
 * flipper's own valuable face-up cards gets actively sought out, not just randomly
 * stumbled into -- see infiltratorDefenseAdjustment. Not proven/calibrated against
 * real playtest data yet -- since the swap was reworked from a resolved-value steal
 * into a full identity swap (see lib/content/cards.ts), whatever number was tuned for
 * the old mechanic doesn't carry over, so this restarts as a reasonable prior pending
 * real data on the new one.
 */
const INFILTRATOR_FLIP_CHANCE_PER_OPPONENT_TURN = 0.22;
/** Below this many face-down cards on the board, a face-down Facestealer reads as unusually exposed (few peers to blend in with, and few plausible future swap targets), so it takes an extra flat penalty. */
const INFILTRATOR_FEW_FACE_DOWN_THRESHOLD = 3;
const INFILTRATOR_FEW_FACE_DOWN_PENALTY = 2;

/**
 * Real expected downside (or, when the swap currently hurts, upside) of a face-down
 * Facestealer's identity swap getting cancelled by a flip before scoring -- the actual
 * gap between its live margin and what its margin would be if flipped right now
 * (hypotheticalFlipMargin, same helper chooseFlip uses for the AI's own targets),
 * discounted by the odds an opponent gets to it before scoring
 * (INFILTRATOR_FLIP_CHANCE_PER_OPPONENT_TURN). Negative return means real risk
 * (a beneficial swap that could get cancelled); positive means a beneficial *relief*
 * is at stake instead (a currently-bad swap that a flip would cancel). Shared by its
 * own placement heuristic (the "Infiltrator" case below) and Cyclops's protection
 * credit (the "Giant" case below) -- a Cyclops that locks a Facestealer in place
 * credits back exactly what placing the Facestealer alone would have discounted,
 * rather than a separately-tuned number that could drift out of sync with it. Uses
 * exactRemainingOpponentTurns rather than a rounds-remaining estimate, so a Facestealer
 * placed on the actual last opponent turn of the game reads as genuinely zero risk,
 * not just a small one -- see that function's own doc comment. `preState` is the state
 * the *placement action itself* is being considered from (not `postState`, since
 * placing either card doesn't change whose turn it is or how many are left).
 */
function infiltratorSwapRiskAtStake(postState: GameState, playerId: string, target: CardInstance, preState: GameState): number {
  const currentMargin = estimateMargin(postState, playerId);
  const marginIfFlipped = hypotheticalFlipMargin(postState, playerId, target);
  const swapValueAtStake = currentMargin - marginIfFlipped;
  const opponentTurns = exactRemainingOpponentTurns(preState);
  const flipChance = saturatingFlipChance(INFILTRATOR_FLIP_CHANCE_PER_OPPONENT_TURN, opponentTurns);
  return -swapValueAtStake * flipChance;
}

/**
 * Each opponent's total, from `viewerId`'s honest point of view (hidden cards read as
 * the neutral Unknown placeholder, same redaction estimateMargin uses) -- unlike
 * estimateMargin, this keeps every opponent's own total instead of collapsing them
 * down to just the max.
 */
function totalsByOpponent(state: GameState, viewerId: string): Record<string, number> {
  const playerIds = state.players.map((p) => p.id);
  const evaluationBoard = redactedBoardFor(state.board, viewerId);
  const { totalsByOwner } = resolveBoard(evaluationBoard, state.config.boardBounds, state.round, state.config.centerEffect, playerIds);
  return totalsByOwner;
}

/** Fraction of a non-leader opponent's real score drop credited as margin -- see nonLeaderDisruptionBonus's comment for why this is needed at all, and why it stays a fraction rather than full credit. */
const NON_LEADER_DISRUPTION_WEIGHT = 0.5;

/**
 * Extra margin credit for lowering *any* opponent's score this placement, not just
 * the current leader's -- the real (fair) margin already fully credits hurting
 * whoever ends up the best opponent post-placement (estimateMargin literally
 * subtracts their total), but bestOther is a max, not a sum: knocking down a rival
 * who isn't in the lead moves the margin not at all, even though it's genuinely
 * lowering that player's score. Applies to any card whose effect touches another
 * player's total -- Earthshaker, Doomherald, Plague Bearer, a Suppressor negating a
 * beneficial neighbor effect, etc. -- not just a fixed list, since it's measured off
 * real pre/post totals rather than guessing at which cards are "disruptive".
 * Weighted at a fraction of the real swing (never enough on its own to override a
 * placement the true margin already recognizes as better), since a hit that doesn't
 * land on the leader is still worth less certainty than one the margin can already
 * see paying off directly.
 */
function nonLeaderDisruptionBonus(preState: GameState, playerId: string, postState: GameState): number {
  const opponentIds = postState.players.map((p) => p.id).filter((id) => id !== playerId);
  if (opponentIds.length === 0) return 0;

  const preTotals = totalsByOpponent(preState, playerId);
  const postTotals = totalsByOpponent(postState, playerId);
  const leaderTotal = Math.max(0, ...opponentIds.map((id) => postTotals[id] ?? 0));

  let bonus = 0;
  for (const id of opponentIds) {
    const postTotal = postTotals[id] ?? 0;
    if (postTotal === leaderTotal) continue; // already fully priced into the real margin via bestOther
    const drop = (preTotals[id] ?? 0) - postTotal;
    if (drop > 0) bonus += drop * NON_LEADER_DISRUPTION_WEIGHT;
  }
  return bonus;
}

/**
 * Additive nudge to a placement candidate's raw (fair, "as if scoring the instant
 * after this placement") margin score -- corrects for cards whose true value depends
 * on how the game unfolds on *later* turns, which a one-ply greedy evaluation can't
 * see at all. Each branch targets one specific card identified from playtesting data;
 * see each one's own comment for the reasoning. This never touches the engine's real
 * (fair) scoring -- it's purely a decision-making nudge, same spirit as
 * berserkerFlipBaitBonus/warlordFlipDeterrenceBonus above. Exported so twoPly.ts can reuse the
 * same calibrated corrections when ranking/pruning its own search candidates, instead
 * of re-deriving a weaker approximation from scratch.
 */
export function placementHeuristicAdjustment(
  preState: GameState,
  playerId: string,
  action: { instanceId: string; position: Position },
  postState: GameState
): number {
  const placedCard = postState.board.get(posKey(action.position));
  if (!placedCard) return 0;
  const roundsRemaining = Math.max(0, expectedFinalRound(preState.config) - preState.round);

  const disruptionBonus = nonLeaderDisruptionBonus(preState, playerId, postState);

  const cardSpecificAdjustment = ((): number => {
    switch (placedCard.cardId) {
      case "Exile": {
        // -1/neighbor is scored off however many neighbors it has *right now* -- but the
        // board keeps filling in on later turns, so the earlier this is placed, the more
        // its real final penalty is being underestimated.
        const emptyAdjacent = countEmptyAdjacentCells(postState.board, postState.config.boardBounds, action.position);
        const expectedNewNeighbors = Math.min(emptyAdjacent, roundsRemaining * EXILE_NEIGHBOR_FILL_RATE_PER_ROUND);
        return -1 * expectedNewNeighbors;
      }

      case "Commander": {
        // +2 per adjacent Footman -- credit any Footmen still in hand (they might end up
        // next to this Commander later) plus a small flat early-game bonus reflecting
        // more turns left to draw and set one up, even with none in hand yet.
        const footmenInHand = postState.players.find((p) => p.id === playerId)!.hand.filter((c) => c.cardId === "Footman").length;
        return footmenInHand * 2 * COMMANDER_HAND_FOOTMAN_WEIGHT + roundsRemaining * COMMANDER_EARLY_GAME_BONUS_PER_ROUND;
      }

      case "Gloryseeker": {
        // +3 only if face-up at scoring -- placed face-down (the common case), the fair
        // margin sees none of that yet. The earlier it's placed (once flips are actually
        // unlocked) and the more opponents there are, the more opponent-turns remain
        // for one of them to plausibly flip it before the game ends -- exactly how many,
        // down to this seat's actual position in the round, via
        // exactRemainingOpponentTurns (so a Gloryseeker placed on the true last opponent
        // turn of the game reads as truly 0 chance, not just a small one).
        if (placedCard.faceUp) return 0;
        const flipChance = saturatingFlipChance(GLORYSEEKER_FLIP_CHANCE_PER_OPPONENT_TURN, exactRemainingOpponentTurns(preState));
        return 3 * flipChance;
      }

      case "Earthshaker": {
        // Its own -2-to-connected-row/col effect is now gated on being face-up (see
        // cards.ts) -- placed face-down (the common case), estimateMargin's immediate
        // snapshot sees zero effect no matter which row/column it lands in, so there's
        // nothing here for the fair margin to distinguish on its own. Credit the
        // expected value of however it actually resolves if it ends up flipped before
        // scoring -- computed for real (hypotheticalFlipMargin, the exact same check
        // chooseFlip itself uses), not reimplemented as a row/column walk, so it
        // automatically nets out self-damage against opponent damage exactly like the
        // real rule does. Two independent flip channels feed into "ever gets flipped":
        // the owner's own deliberate flip (real, board-aware, see
        // EARTHSHAKER_SELF_FLIP_CHANCE_PER_OWN_TURN's doc comment for why that's not
        // blind luck) and an opponent's blind exploration flip (Earthshaker isn't
        // opponentOnlyFlip, so it's exposed to the same generic risk any hidden card
        // is) -- combined as "at least one of these independent channels lands it,"
        // not simply added.
        if (placedCard.faceUp) return 0;
        const marginIfFlipped = hypotheticalFlipMargin(postState, playerId, placedCard) - estimateMargin(postState, playerId);
        if (marginIfFlipped <= 0) return 0; // never worth crediting a flip that would net hurt its own owner
        const selfFlipChance = saturatingFlipChance(EARTHSHAKER_SELF_FLIP_CHANCE_PER_OWN_TURN, exactRemainingOwnTurns(preState));
        const opponentFlipChance = saturatingFlipChance(GLORYSEEKER_FLIP_CHANCE_PER_OPPONENT_TURN, exactRemainingOpponentTurns(preState));
        const everFlippedChance = 1 - (1 - selfFlipChance) * (1 - opponentFlipChance);
        return marginIfFlipped * everFlippedChance;
      }

      case "Infiltrator": {
        // "Facestealer": its identity swap only holds while face-down -- getting
        // flipped (by an opponent; its own owner never would, except in the relief
        // case below) reverts it to its own printed identity. Unlike the old
        // resolved-value swap this discount used to be calibrated against, an
        // identity swap's real stakes vary wildly by target (swapping into a Dying
        // God deep into the game is a very different bet than swapping into a
        // Berserker with no rivals yet), so instead of guessing a flat number this
        // computes the *actual* current swap value at stake -- the real gap between
        // its live margin and what its margin would be if flipped right now
        // (hypotheticalFlipMargin, the same helper chooseFlip uses for the AI's own
        // targets) -- and discounts by the odds an opponent gets to it before
        // scoring. When the swap currently HURTS this player (it landed on something
        // worse off than its own base), the sign flips naturally: a flip is then a
        // real chance of relief, not risk, and this correctly turns into a bonus. A
        // board with very few other face-down cards also leaves it unusually exposed
        // (few peers to blend in with), on top of that.
        if (placedCard.faceUp) return 0;
        const faceDownOnBoard = [...postState.board.values()].filter((c) => !c.faceUp).length;
        let adjustment = infiltratorSwapRiskAtStake(postState, playerId, placedCard, preState);
        if (faceDownOnBoard < INFILTRATOR_FEW_FACE_DOWN_THRESHOLD) adjustment -= INFILTRATOR_FEW_FACE_DOWN_PENALTY;
        return adjustment;
      }

      case "Giant": {
        // "Cyclops": no adjacent card can be flipped by anyone while it stays
        // adjacent to this one (see blocksAdjacentFlips in lib/content/cards.ts). The
        // clearest safe use of that here: a face-down Facestealer of ours placed next
        // to a Cyclops is now permanently immune to being flipped, so its swap risk
        // (see infiltratorSwapRiskAtStake / the "Infiltrator" case above) drops from
        // "discounted by flip odds" to exactly zero -- credit back precisely what that
        // risk term currently subtracts. The negation stays correct even when the
        // swap is currently a bad one hoping to get cancelled by a flip: locking it
        // away permanently debits for losing that chance at relief, same as it would
        // credit for protecting a good one.
        //
        // Deliberately doesn't try to credit denying an *opponent's* face-down card
        // (e.g. permanently locking away their own Gloryseeker so they can never cash
        // its +3) -- doing that honestly would mean weighing every possible hidden
        // identity the way expectedHiddenNeighborAdjustments does (see endgame.ts),
        // not just checking a neighbor's true cardId, which this heuristic layer never
        // does for anyone but the acting player's own cards (see e.g.
        // infiltratorDefenseAdjustment's `n.ownerId === playerId` guard above -- same
        // rule here).
        let protectionCredit = 0;
        for (const n of getAdjacentCards(postState.board, postState.config.boardBounds, action.position)) {
          if (n.ownerId === playerId && !n.faceUp && n.cardId === "Infiltrator") {
            protectionCredit -= infiltratorSwapRiskAtStake(postState, playerId, n, preState);
          }
        }
        return protectionCredit;
      }

      case "Chronicler": {
        // "Doomherald": -3 to every adjacent card (any owner) once face-up, but
        // opponentOnlyFlip means only an opponent can trigger it -- the fair margin
        // only ever sees this if it's ALREADY face-up (the rare case; skip). Placed
        // face-down (the common case), credit the expected value: chance an opponent
        // eventually flips it (same saturating model as Gloryseeker, its own rate --
        // see DOOMHERALD_FLIP_CHANCE_PER_OPPONENT_TURN) times the net damage among
        // its *current* neighbors -- hitting an opponent's card is a real margin gain,
        // hitting one of ours is a real cost, and both happen together if triggered,
        // so they're netted rather than only crediting the upside.
        if (placedCard.faceUp) return 0;
        const flipChance = saturatingFlipChance(DOOMHERALD_FLIP_CHANCE_PER_OPPONENT_TURN, exactRemainingOpponentTurns(preState));
        const neighbors = getAdjacentCards(postState.board, postState.config.boardBounds, action.position);
        let netNeighborDamage = 0;
        for (const n of neighbors) netNeighborDamage += n.ownerId === playerId ? -3 : 3;
        return netNeighborDamage * flipChance;
      }

      case "Berserker": {
        // +2 per other copy anywhere (own or enemy) -- worthless by the fair margin
        // until any other Berserker actually lands on the board, so on pure margin
        // math this always ranks near the bottom. See expectedNewCopiesOf for the
        // derivation (already correctly returns 0 once no hidden copies remain).
        return 2 * expectedNewCopiesOf(postState, "Berserker");
      }

      case "Warlord": {
        // -2 per other copy anywhere -- the opposite problem from Berserker: base 8
        // means the fair margin already looks great the instant it's placed (no other
        // copy has landed yet), but that snapshot doesn't discount for the real risk
        // that one does later. Docks the same expected-new-copies estimate as a risk
        // discount instead of a credit.
        return -2 * expectedNewCopiesOf(postState, "Warlord");
      }

      case "DyingGod": {
        // -1 per round elapsed *when the game ends* -- the fair margin's
        // postState.round snapshot is systematically *overvalued* the earlier it's
        // placed (round 1 looks like base-1, when it's really headed toward
        // base-expectedFinalRound). Dock it down to what it's really expected to be
        // worth once the game actually ends.
        return -(expectedFinalRound(postState.config) - postState.round);
      }

      case "Skysplitter": {
        // +1 per round elapsed *when the game ends* -- the same expectedFinalRound
        // correction as DyingGod, opposite sign: the fair margin's postState.round
        // snapshot systematically *undervalues* it the earlier it's placed (round 1
        // looks like base+1, when it's really headed toward base+expectedFinalRound).
        // Credit it up to what it's really expected to be worth once the game
        // actually ends.
        return expectedFinalRound(postState.config) - postState.round;
      }

      default:
        return 0;
    }
  })();

  return cardSpecificAdjustment + disruptionBonus;
}

/** Places whichever (card, cell) combination yields the best resulting margin. */
function choosePlacement(state: GameState, playerId: string, rng: Rng): GameAction {
  const offered = offeredCardsFor(state, playerId);
  const legalCells = getLegalPlacementCells(state);
  if (offered.length === 0 || legalCells.length === 0) {
    return { type: "pass", playerId };
  }

  const candidates: { instanceId: string; position: Position }[] = [];
  for (const card of offered) {
    for (const position of legalCells) {
      candidates.push({ instanceId: card.instanceId, position });
    }
  }

  const best = pickBest(
    candidates,
    (candidate) => {
      const postState = applyPlace(state, { type: "place", playerId, ...candidate });
      return estimateMargin(postState, playerId) + placementHeuristicAdjustment(state, playerId, candidate, postState);
    },
    rng
  );

  return { type: "place", playerId, instanceId: best.instanceId, position: best.position };
}

/**
 * Same call convention as chooseAiAction in randomAi.ts (state, playerId, rng) ->
 * GameAction, so it's a drop-in replacement -- a turn is still up to two calls (an
 * optional flip, then always a place/pass), and a pending vote is handled the same way.
 * All scoring goes through the engine's fair, per-player evaluation (endgame.ts) --
 * this module never reads an opponent's hidden card identity directly.
 */
export function chooseGreedyAiAction(state: GameState, playerId: string, rng: Rng = Math.random): GameAction {
  if (state.phase === "voting") {
    if (playerId in state.votes) throw new Error(`${playerId} has already voted`);
    return { type: "castVote", playerId, vote: computeAiVote(state, playerId, rng) };
  }

  if (playerId !== currentPlayerId(state)) {
    throw new Error(`It is not ${playerId}'s turn`);
  }

  const flipInstanceId = chooseFlip(state, playerId, rng);
  if (flipInstanceId) {
    return { type: "flip", playerId, instanceId: flipInstanceId };
  }

  return choosePlacement(state, playerId, rng);
}
