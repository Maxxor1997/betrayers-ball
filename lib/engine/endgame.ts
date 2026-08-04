import { getLegalPlacementPositions } from "./board";
import { resolveBoard } from "./resolution";
import { Board, BoardBounds, GameResult } from "./types";

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
  playerIds: string[]
): GameResult {
  const { totalsByOwner } = resolveBoard(board, bounds, finalRound);
  const scores: Record<string, number> = {};
  for (const id of playerIds) scores[id] = totalsByOwner[id] ?? 0;

  const maxScore = Math.max(...playerIds.map((id) => scores[id]));
  const winnerIds = playerIds.filter((id) => scores[id] === maxScore);

  return { scores, winnerIds };
}
