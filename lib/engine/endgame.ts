import { getLegalPlacementPositions } from "./board";
import { getVisibleBoard } from "./playerView";
import { resolveBoard } from "./resolution";
import { Board, BoardBounds, CardInstance, CenterEffectId, GameResult, GameState } from "./types";

export function isBoardFull(board: Board, bounds: BoardBounds): boolean {
  return getLegalPlacementPositions(board, bounds).length === 0;
}

export function isRoundCapHit(completedRound: number, roundCap: number): boolean {
  return completedRound >= roundCap;
}

/** Board-fill and the round cap end the game unconditionally, checked at a round boundary. */
export function shouldEndGame(board: Board, bounds: BoardBounds, completedRound: number, roundCap: number): boolean {
  return isBoardFull(board, bounds) || isRoundCapHit(completedRound, roundCap);
}

/**
 * How likely an AI is to vote to end the game on a given round -- increases linearly
 * as the game goes on, reaching certainty at the round cap. Not a spec number; a
 * reasonable default for the single-device AI opponent.
 */
export function aiVoteProbability(round: number, roundCap: number): number {
  return Math.min(1, round / roundCap);
}

/**
 * Final scoring: resolves the frozen board and totals each player's owned-card values.
 * Tie-break: the spec (game_spec.md v2) flags final-tie-break as an explicitly missing
 * rule. Default here is a shared win — winnerIds can hold multiple ids on a tie.
 */
export function computeGameResult(
  board: Board,
  bounds: BoardBounds,
  finalRound: number,
  playerIds: string[],
  centerEffect: CenterEffectId = "none"
): GameResult {
  const { totalsByOwner } = resolveBoard(board, bounds, finalRound, centerEffect, playerIds);
  const scores: Record<string, number> = {};
  for (const id of playerIds) scores[id] = totalsByOwner[id] ?? 0;

  const maxScore = Math.max(...playerIds.map((id) => scores[id]));
  const winnerIds = playerIds.filter((id) => scores[id] === maxScore);

  return { scores, winnerIds };
}

/**
 * A card whose identity a viewer can't see (an opponent's face-down card) is treated
 * as this when estimating standing -- a flat, effect-free stand-in worth roughly the
 * deck-wide average base value (CARD_DEFS.Unknown.base), a documented approximation
 * rather than a probability model. Deliberately has no valueModifier of its own (unlike
 * substituting a real card, e.g. Footman, which would incorrectly apply that card's
 * printed effect to something that isn't actually it) -- it can still be pushed around
 * by *other* cards' neighbor effects (Bannerman, Skysplitter, ...), same as any real
 * card would be. This deliberately undercounts how dangerous a truly-hidden Warlord/
 * Exile might be; the alternative (Bayesian reasoning over remaining deck composition)
 * is real work this 1-ply heuristic doesn't attempt.
 */
const UNKNOWN_CARD_PLACEHOLDER = "Unknown" as const;

function toEvaluationBoard(board: Board, viewerId: string): Board {
  const visible = getVisibleBoard(board, viewerId);
  const evaluationBoard: Board = new Map();
  for (const [key, vc] of visible.entries()) {
    const card: CardInstance = {
      instanceId: vc.instanceId,
      ownerId: vc.ownerId,
      faceUp: vc.faceUp,
      cardId: vc.cardId ?? UNKNOWN_CARD_PLACEHOLDER,
    };
    evaluationBoard.set(key, card);
  }
  return evaluationBoard;
}

/**
 * A player's own honest estimate of standing: "my total minus the best opponent's
 * total", using only what they could actually know -- their own cards plus anything
 * face-up. An opponent's still-hidden card never contributes its true effect here, so
 * this never leaks hidden information. Shared by the engine's automatic AI vote-fill
 * and by AI turn-decision modules that want a fair evaluation function.
 */
export function estimateMargin(state: GameState, viewerId: string): number {
  const playerIds = state.players.map((p) => p.id);
  const evaluationBoard = toEvaluationBoard(state.board, viewerId);
  const { totalsByOwner } = resolveBoard(
    evaluationBoard,
    state.config.boardBounds,
    state.round,
    state.config.centerEffect,
    playerIds
  );
  const myScore = totalsByOwner[viewerId] ?? 0;
  const bestOther = Math.max(0, ...playerIds.filter((id) => id !== viewerId).map((id) => totalsByOwner[id] ?? 0));
  return myScore - bestOther;
}

/**
 * How many margin points correspond to one e-fold of odds in the logistic curve below
 * -- smaller means the AI's vote reacts more sharply to a given point gap. 5 was
 * picked so a single mid-value card's worth of lead (e.g. one Footman) noticeably
 * moves the needle without already being a near-certain yes on its own.
 */
const VOTE_MARGIN_SCALE = 5;

/** Floor/ceiling on the yes-vote probability -- keeps the vote genuinely random even at a landslide margin, never fully deterministic either way. */
const MIN_VOTE_YES_PROBABILITY = 0.05;
const MAX_VOTE_YES_PROBABILITY = 0.95;

/**
 * Chance of voting yes, purely as a function of the current fair margin -- a logistic
 * curve centered on 0 (tied game -> 50/50), growing more likely to end the further
 * ahead the AI is and less likely the further behind, clamped so it's never fully
 * certain either way.
 */
function marginToVoteYesProbability(margin: number): number {
  const logistic = 1 / (1 + Math.exp(-margin / VOTE_MARGIN_SCALE));
  return Math.min(MAX_VOTE_YES_PROBABILITY, Math.max(MIN_VOTE_YES_PROBABILITY, logistic));
}

/**
 * Vote yes/no purely off the player's own (fair) margin estimate, via
 * marginToVoteYesProbability -- deliberately ignores the round. Whether to end is a
 * fresh decision every time voting comes up, not a countdown; the round cap already
 * force-ends the game on its own once reached, so there's no separate need to ramp
 * pressure by round here too.
 */
export function computeAiVote(state: GameState, playerId: string, rng: () => number): boolean {
  const margin = estimateMargin(state, playerId);
  return rng() < marginToVoteYesProbability(margin);
}
