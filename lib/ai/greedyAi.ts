import { computeAiVote, estimateMargin } from "../engine/endgame";
import { applyPlace, currentPlayerId, getLegalFlipTargets, getLegalPlacementCells } from "../engine/turns";
import { GameAction, GameState, Position } from "../engine/types";

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

/** Baseline chance of flipping an opponent's card speculatively, when no own-card
 * flip is worth it -- see the note in chooseFlip on why this can't be value-ranked. */
const OPPONENT_FLIP_EXPLORATION_PROBABILITY = 0.2;

function hypotheticalFlipMargin(state: GameState, playerId: string, target: { instanceId: string }): number {
  const board = new Map(state.board);
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  board.set(entry[0], { ...entry[1], faceUp: true });
  return estimateMargin({ ...state, board }, playerId);
}

/**
 * Flips the target that improves the (fair) margin the most -- but only among the
 * player's own face-down cards, which they already know the identity of, so ranking
 * them by true post-flip value is fair. An opponent's face-down cards can't be ranked
 * this way without peeking (their true post-flip value literally requires knowing
 * their hidden identity first) -- so a flip target there, if any, is chosen instead of
 * a value-driven one, blind, at a flat exploration rate.
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

  if (opponentTargets.length > 0 && rng() < OPPONENT_FLIP_EXPLORATION_PROBABILITY) {
    return opponentTargets[Math.floor(rng() * opponentTargets.length)].instanceId;
  }

  return null;
}

/** Places whichever (card, cell) combination yields the best resulting margin. */
function choosePlacement(state: GameState, playerId: string, rng: Rng): GameAction {
  const player = state.players.find((p) => p.id === playerId)!;
  const legalCells = getLegalPlacementCells(state);
  if (player.hand.length === 0 || legalCells.length === 0) {
    return { type: "pass", playerId };
  }

  const candidates: { instanceId: string; position: Position }[] = [];
  for (const card of player.hand) {
    for (const position of legalCells) {
      candidates.push({ instanceId: card.instanceId, position });
    }
  }

  const best = pickBest(
    candidates,
    (candidate) => estimateMargin(applyPlace(state, { type: "place", playerId, ...candidate }), playerId),
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
