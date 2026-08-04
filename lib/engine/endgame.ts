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
 * as this when estimating standing -- the single most common card in the deck (12/68),
 * a documented approximation rather than a probability model. This deliberately
 * undercounts how dangerous a truly-hidden Warlord/Exile might be; the alternative
 * (Bayesian reasoning over remaining deck composition) is real work this 1-ply
 * heuristic doesn't attempt.
 */
const UNKNOWN_CARD_PLACEHOLDER = "Footman" as const;

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
 * Vote yes if currently ahead by the player's own (fair) estimate -- lock in the win.
 * Otherwise fall back to the round-based pressure, dampened while behind (worth
 * catching up first) but still climbing as the game goes on.
 */
export function computeAiVote(state: GameState, playerId: string, rng: () => number): boolean {
  const margin = estimateMargin(state, playerId);
  if (margin > 0) return true;
  const base = aiVoteProbability(state.round, state.config.roundCap);
  const probability = margin === 0 ? base : base * 0.6;
  return rng() < probability;
}
