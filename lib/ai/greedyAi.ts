import { adjacentPositions, isOwnerlessPosition, parsePosKey, posKey } from "../engine/board";
import { computeAiVote, estimateMargin } from "../engine/endgame";
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
 * is worth it -- see the note in chooseFlip on why this can't be value-ranked. Set
 * high, not 50/50: only Gloryseeker clearly wants to stay hidden for its owner (+3 face-
 * up), so revealing is very rarely a gift to them, and the information is otherwise
 * free -- a real player grabs it almost every time rather than passing on a free look.
 */
const OPPONENT_FLIP_EXPLORATION_PROBABILITY = 0.85;

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
 * a value-driven one, blind, weighted toward targets adjacent to the AI's own cards, at
 * a flat exploration rate.
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

  if (opponentTargets.length > 0 && rng() < OPPONENT_FLIP_EXPLORATION_PROBABILITY) {
    const best = pickBest(
      opponentTargets,
      (target) => opponentTargetPriority(state.board, playerId, target),
      rng
    );
    return best.instanceId;
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
const SPECULATIVE_PLAY_PROBABILITY = 0.25;

/**
 * Rough expected round the game actually ends on. game.ts's config keeps roundCap and
 * minRoundFloor flat regardless of player count (6 and 3 respectively, see
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

/** Rough chance, per remaining round once flips are actually unlocked, that a face-down Gloryseeker ends up face-up (by either player) before scoring. */
const GLORYSEEKER_FLIP_CHANCE_PER_ROUND = 0.15;

/** Flat per-remaining-round discount on a face-down Infiltrator's current swap value, reflecting the cumulative risk it gets flipped (forfeiting the swap) before scoring. */
const INFILTRATOR_FLIP_RISK_PER_ROUND = 0.5;
/** Below this many face-down cards on the board, a face-down Infiltrator reads as unusually exposed (few peers to blend in with, and few plausible future swap targets), so it takes an extra flat penalty. */
const INFILTRATOR_FEW_FACE_DOWN_THRESHOLD = 3;
const INFILTRATOR_FEW_FACE_DOWN_PENALTY = 2;

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

  switch (placedCard.cardId) {
    case "Exile": {
      // -2/neighbor is scored off however many neighbors it has *right now* -- but the
      // board keeps filling in on later turns, so the earlier this is placed, the more
      // its real final penalty is being underestimated.
      const emptyAdjacent = countEmptyAdjacentCells(postState.board, postState.config.boardBounds, action.position);
      const expectedNewNeighbors = Math.min(emptyAdjacent, roundsRemaining * EXILE_NEIGHBOR_FILL_RATE_PER_ROUND);
      return -2 * expectedNewNeighbors;
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
      // unlocked), the more turns remain for it to plausibly get flipped by either
      // player before the game ends.
      if (placedCard.faceUp) return 0;
      const roundsWithFlipAvailable = Math.max(0, expectedFinalRound(postState.config) - Math.max(preState.round, postState.config.flipUnlockRound));
      const flipChance = Math.min(1, roundsWithFlipAvailable * GLORYSEEKER_FLIP_CHANCE_PER_ROUND);
      return 3 * flipChance;
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
      // +1 per round elapsed *when the game ends* -- the fair margin only ever counts
      // postState.round (the current round, frozen at "as if scoring right now"), so
      // it's systematically undervalued the earlier it's placed. Top it up to what
      // it's really expected to be worth once the game actually ends.
      return expectedFinalRound(postState.config) - postState.round;
    }

    default:
      return 0;
  }
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
