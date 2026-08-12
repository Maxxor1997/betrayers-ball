import { adjacentPositions, getAdjacentCards, isOwnerlessPosition, parsePosKey, posKey } from "../engine/board";
import { CARD_DEFS, copiesForPlayerCount } from "../content/cards";
import { computeAiVote, estimateMargin } from "../engine/endgame";
import { redactedBoardFor } from "../engine/playerView";
import { resolveBoard } from "../engine/resolution";
import { applyPlace, currentPlayerId, getLegalFlipTargets, getLegalPlacementCells } from "../engine/turns";
import { Board, BoardBounds, CardInstance, GameAction, GameConfig, GameState, Position } from "../engine/types";

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
 * high, not 50/50: only Gloryseeker clearly wants to stay hidden for its owner (+4
 * face-up), and it's a small slice of the deck, so a blind flip is still usually a
 * free look. But it's not *zero* risk either -- flipping a hidden card that happens to
 * be an opponent's Gloryseeker hands them a free +4, so this is nudged down a bit
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
 * Extra priority for a blind opponent flip target from any Truthseeker/Beacon
 * neighbor whose owner is actually known -- either the flipper's own card (always
 * known, even face-down) or a revealed face-up card, the same honest info
 * estimateMargin itself is limited to. Flipping the target face-up has a real,
 * certain consequence for each such neighbor even though the target's own identity
 * stays unknown until it's flipped:
 * - An adjacent Truthseeker is currently dealing the target -3 for being face-down
 *   (see lib/content/cards.ts) -- flipping removes that, which only ever helps the
 *   target's owner (an opponent), so it's discouraged regardless of who owns the
 *   Truthseeker.
 * - An adjacent Beacon gains +1 once the target is face-up -- worth flipping toward
 *   if that Beacon is the flipper's own, worth avoiding if it belongs to anyone else.
 */
function truthseekerBeaconFlipAdjustment(board: Board, bounds: BoardBounds, playerId: string, target: CardInstance): number {
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  const pos = parsePosKey(entry[0]);
  let adjustment = 0;
  for (const n of getAdjacentCards(board, bounds, pos)) {
    const identityKnown = n.ownerId === playerId || n.faceUp;
    if (!identityKnown) continue;
    if (n.cardId === "Truthseeker") adjustment -= 3;
    else if (n.cardId === "Beacon") adjustment += n.ownerId === playerId ? 1 : -1;
  }
  return adjustment;
}

/**
 * Extra priority for a blind opponent flip target adjacent to one of the flipper's own
 * face-up cards, scaled by that neighbor's base value. Infiltrator only swaps with a
 * face-up neighbor now (see lib/content/cards.ts), so a face-down opponent card
 * sitting next to a valuable face-up card of ours is a live threat -- it might BE an
 * Infiltrator waiting to steal that value at scoring, and flipping it face-up is the
 * counter (a face-up Infiltrator's own valueModifier bails out immediately, forfeiting
 * the swap). The AI can't know the target's identity before flipping, so this can't be
 * certain -- just a heuristic nudge toward defending whatever's most worth protecting,
 * on top of opponentTargetPriority's plain adjacency signal.
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
 * -- Infiltrator's threat is calibrated from real playtest data and Doomherald's isn't
 * yet, so this starts as a real but subordinate caution on top of that proven signal,
 * pending its own calibration once Doomherald has actually been played.
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
 * them; holding a Beacon means face-up cards are worth more existing in general
 * (future neighbors for its +1/face-up-neighbor once placed), so exploring more
 * grows that pool.
 */
const HAND_TRUTHSEEKER_EXPLORATION_DISCOUNT = 0.15;
const HAND_BEACON_EXPLORATION_BONUS = 0.15;

/**
 * Further discount on the exploration rate when the AI has a face-down Infiltrator at
 * stake -- either already on the board, or still in hand (a future placement, same
 * as the Truthseeker/Beacon hand nudges above). Infiltrator's entire value depends on
 * staying face-down until scoring (its own valueModifier bails out immediately once
 * faceUp -- see lib/content/cards.ts), and every flip this AI initiates is a small
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
 * Cards whose own printed effect doesn't care about their own face state at all --
 * Berserker's and Warlord's `valueModifier`s count matching cardIds straight off
 * `board.values()` with no `faceUp` check, so flipping either face-up changes nothing
 * about the owner's own margin (hypotheticalFlipMargin always comes back equal to
 * baseline for these, so the margin-ranked branch above never picks them). The only
 * reason a human flips one is the social move this models: showing it off to bait
 * opponents into playing/revealing a matching card of their own, which *does* help --
 * once it's visible, Berserker/Warlord's real bonus/penalty starts applying. Pure
 * bluffing, so it isn't margin-driven; it's a flat chance instead, same shape as
 * SPECULATIVE_CARD_IDS below.
 */
const BLUFF_FLIP_CARD_IDS = new Set(["Berserker", "Warlord"]);

/** Chance, each time the AI has an eligible face-down bluff card of its own, that it reveals one instead of doing the usual margin/exploration flip. */
const BLUFF_FLIP_PROBABILITY = 0.25;

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
 * board (see HAND_TRUTHSEEKER_EXPLORATION_DISCOUNT/HAND_BEACON_EXPLORATION_BONUS/
 * INFILTRATOR_EXPLORATION_DISCOUNT) and by public deck knowledge (see
 * DOOMHERALD_DECK_PRESENCE_EXPLORATION_DISCOUNT).
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
    const score = hypotheticalFlipMargin(state, playerId, target);
    if (score > bestOwnScore) {
      bestOwnScore = score;
      bestOwnTargets = [target.instanceId];
    } else if (score === bestOwnScore && score > baseline) {
      bestOwnTargets.push(target.instanceId);
    }
  }

  if (bestOwnTargets.length > 0) {
    return bestOwnTargets[Math.floor(rng() * bestOwnTargets.length)];
  }

  const bluffTargets = ownTargets.filter((t) => BLUFF_FLIP_CARD_IDS.has(t.cardId));
  if (bluffTargets.length > 0 && rng() < BLUFF_FLIP_PROBABILITY) {
    return bluffTargets[Math.floor(rng() * bluffTargets.length)].instanceId;
  }

  if (opponentTargets.length > 0) {
    const hand = state.players.find((p) => p.id === playerId)!.hand;
    const hasVulnerableInfiltrator =
      hand.some((c) => c.cardId === "Infiltrator") ||
      [...state.board.values()].some((c) => c.ownerId === playerId && c.cardId === "Infiltrator" && !c.faceUp);
    let explorationProbability = OPPONENT_FLIP_EXPLORATION_PROBABILITY;
    if (hand.some((c) => c.cardId === "Truthseeker")) explorationProbability -= HAND_TRUTHSEEKER_EXPLORATION_DISCOUNT;
    if (hand.some((c) => c.cardId === "Beacon")) explorationProbability += HAND_BEACON_EXPLORATION_BONUS;
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
 * Cards worth playing speculatively, ahead of what pure margin math justifies --
 * effects whose payoff depends on other players following suit, so nobody's ever the
 * first to play one on merit alone (a real human will gamble on it anyway, hoping to
 * bait others; the 1-ply greedy AI can't see that far ahead, so it needs a nudge).
 * Currently just Berserker (+2 per opposing Berserker) -- extend this set if other
 * cards get the same "worthless until someone else follows" shape.
 */
const SPECULATIVE_CARD_IDS = new Set(["Berserker"]);

/** Chance, each time the AI has a speculative card in hand, that it plays that card instead of the margin-best one. */
const SPECULATIVE_PLAY_PROBABILITY = 0.15;

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

/** Empty (unoccupied, non-ownerless) cells orthogonally adjacent to `pos` -- candidate spots a future placement could still fill in before scoring. */
function countEmptyAdjacentCells(board: Board, bounds: BoardBounds, pos: Position): number {
  return adjacentPositions(pos, bounds).filter((p) => !isOwnerlessPosition(p, bounds) && !board.has(posKey(p))).length;
}

/** Rough fraction of a currently-empty neighbor cell expected to fill in per remaining round, for Exile's future-neighbor discount below. Not derived from anything -- a modest, clearly-bounded playtesting estimate. */
const EXILE_NEIGHBOR_FILL_RATE_PER_ROUND = 0.4;

/** Value credited per Footman still in the player's own hand when considering a Commander placement -- a fraction of the full +2 adjacency bonus, since there's no guarantee that Footman ever actually lands adjacent to this Commander. */
const COMMANDER_HAND_FOOTMAN_WEIGHT = 1;
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
 * Combines a per-opponent-turn flip rate across every opponent-turn still available
 * before scoring, as "at least one of N independent attempts lands on it"
 * (1 - (1-p)^N) -- saturating, not linear, so it never overshoots 1 the way naively
 * multiplying opponentCount * roundsRemaining * p would once N gets large at 8p. Shared
 * by every `opponentOnlyFlip` card's placement heuristic (Gloryseeker, Doomherald --
 * see their own per-turn rate constants above), since "some opponent eventually takes
 * a blind flip that happens to land here" is the same shape of event for any of them.
 */
function saturatingFlipChance(perOpponentTurnRate: number, roundsWithFlipAvailable: number, opponentCount: number): number {
  const opponentTurns = roundsWithFlipAvailable * opponentCount;
  return 1 - (1 - perOpponentTurnRate) ** opponentTurns;
}

/** Flat per-remaining-round discount on a face-down Infiltrator's current swap value, reflecting the cumulative risk it gets flipped (forfeiting the swap) before scoring. */
const INFILTRATOR_FLIP_RISK_PER_ROUND = 0.5;
/** Below this many face-down cards on the board, a face-down Infiltrator reads as unusually exposed (few peers to blend in with, and few plausible future swap targets), so it takes an extra flat penalty. */
const INFILTRATOR_FEW_FACE_DOWN_THRESHOLD = 3;
const INFILTRATOR_FEW_FACE_DOWN_PENALTY = 2;

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
 * player's total -- Earthshaker, Skysplitter, Plague Bearer, a Suppressor negating a
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
 * (fair) scoring -- it's purely a decision-making nudge for this module, same spirit
 * as SPECULATIVE_CARD_IDS/BLUFF_FLIP_CARD_IDS above.
 */
function placementHeuristicAdjustment(
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
        // +4 only if face-up at scoring -- placed face-down (the common case), the fair
        // margin sees none of that yet. The earlier it's placed (once flips are actually
        // unlocked) and the more opponents there are, the more opponent-turns remain
        // for one of them to plausibly flip it before the game ends.
        if (placedCard.faceUp) return 0;
        const roundsWithFlipAvailable = Math.max(0, expectedFinalRound(postState.config) - Math.max(preState.round, postState.config.flipUnlockRound));
        const opponentCount = postState.players.length - 1;
        const flipChance = saturatingFlipChance(GLORYSEEKER_FLIP_CHANCE_PER_OPPONENT_TURN, roundsWithFlipAvailable, opponentCount);
        return 4 * flipChance;
      }

      case "Infiltrator": {
        // Its swap bonus only applies while face-down -- the more turns remain before
        // scoring, the higher the cumulative chance it gets flipped (by either player)
        // and forfeits it, and a board with very few other face-down cards leaves it
        // unusually exposed. The fair margin has no way to see either risk.
        if (placedCard.faceUp) return 0;
        const faceDownOnBoard = [...postState.board.values()].filter((c) => !c.faceUp).length;
        let adjustment = -roundsRemaining * INFILTRATOR_FLIP_RISK_PER_ROUND;
        if (faceDownOnBoard < INFILTRATOR_FEW_FACE_DOWN_THRESHOLD) adjustment -= INFILTRATOR_FEW_FACE_DOWN_PENALTY;
        return adjustment;
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
        const roundsWithFlipAvailable = Math.max(0, expectedFinalRound(postState.config) - Math.max(preState.round, postState.config.flipUnlockRound));
        const opponentCount = postState.players.length - 1;
        const flipChance = saturatingFlipChance(DOOMHERALD_FLIP_CHANCE_PER_OPPONENT_TURN, roundsWithFlipAvailable, opponentCount);
        const neighbors = getAdjacentCards(postState.board, postState.config.boardBounds, action.position);
        let netNeighborDamage = 0;
        for (const n of neighbors) netNeighborDamage += n.ownerId === playerId ? -3 : 3;
        return netNeighborDamage * flipChance;
      }

      case "DyingGod": {
        // -1 per round elapsed *when the game ends* -- the fair margin's
        // postState.round snapshot is systematically *overvalued* the earlier it's
        // placed (round 1 looks like base-1, when it's really headed toward
        // base-expectedFinalRound). Dock it down to what it's really expected to be
        // worth once the game actually ends.
        return -(expectedFinalRound(postState.config) - postState.round);
      }

      default:
        return 0;
    }
  })();

  return cardSpecificAdjustment + disruptionBonus;
}

/** Places whichever (card, cell) combination yields the best resulting margin. */
function choosePlacement(state: GameState, playerId: string, rng: Rng): GameAction {
  const player = state.players.find((p) => p.id === playerId)!;
  const legalCells = getLegalPlacementCells(state);
  if (player.hand.length === 0 || legalCells.length === 0) {
    return { type: "pass", playerId };
  }

  let handForCandidates = player.hand;
  const speculativeCards = player.hand.filter((c) => SPECULATIVE_CARD_IDS.has(c.cardId));
  if (speculativeCards.length > 0 && rng() < SPECULATIVE_PLAY_PROBABILITY) {
    handForCandidates = speculativeCards;
  }

  const candidates: { instanceId: string; position: Position }[] = [];
  for (const card of handForCandidates) {
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
