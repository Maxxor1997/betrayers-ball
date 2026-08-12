import { getLegalPlacementPositions } from "./board";
import { redactedBoardFor } from "./playerView";
import { resolveBoard, ResolutionResult } from "./resolution";
import { Board, BoardBounds, CenterEffectId, GameResult, GameState } from "./types";

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
 * Full board resolution using only what `viewerId` could actually know -- their own
 * cards (face-up or not) plus anything face-up on the board; an opponent's
 * still-hidden card resolves as the neutral "Unknown" pseudo-card (see
 * redactedBoardFor), never its true effect, so nothing here leaks hidden information.
 * This is a live, provisional resolution, not the final one: because effects are
 * neighbor-dependent, a card's contribution can (and will) change as more of the
 * board fills in around it, so the same call made again next turn can legitimately
 * return different numbers for cards already on the board.
 */
export function estimatedResolutionFor(state: GameState, viewerId: string): ResolutionResult {
  const playerIds = state.players.map((p) => p.id);
  const evaluationBoard = redactedBoardFor(state.board, viewerId);
  return resolveBoard(evaluationBoard, state.config.boardBounds, state.round, state.config.centerEffect, playerIds);
}

/**
 * A player's own honest estimate of standing: "my total minus the best opponent's
 * total", using only what they could actually know. Shared by the engine's automatic
 * AI vote-fill and by AI turn-decision modules that want a fair evaluation function.
 */
export function estimateMargin(state: GameState, viewerId: string): number {
  const { totalsByOwner } = estimatedResolutionFor(state, viewerId);
  const myScore = totalsByOwner[viewerId] ?? 0;
  const bestOther = Math.max(0, ...state.players.filter((p) => p.id !== viewerId).map((p) => totalsByOwner[p.id] ?? 0));
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
 * Extra margin credit for Dying God, the only card left whose value is a known, exact
 * function of the round -- "what would one more round do to my score" can be answered
 * precisely (-1) instead of guessed at. Its owner is strictly worse off if the game
 * keeps going, so gets a nudge toward voting yes (lock in the current, better value
 * now). Chronicler ("Doomherald") used to get the mirrored nudge here when its own
 * effect was +1/round elapsed -- now that it's "-3 to adjacent cards while face-up,
 * opponent-only flip" (see lib/content/cards.ts), its value has nothing to do with
 * the round anymore, just whether an opponent ever flips it; there's no similarly
 * precise, cheap-to-compute vote nudge for that, so it's left to the plain margin
 * estimate like everything else uncertain. Own cards only -- a still-hidden opponent
 * Dying God might exist too, but there's no fair way to guess that without leaking
 * hidden information, matching every other heuristic in this codebase.
 */
function roundSensitiveVoteAdjustment(state: GameState, playerId: string): number {
  let adjustment = 0;
  for (const c of state.board.values()) {
    if (c.ownerId === playerId && c.cardId === "DyingGod") adjustment += 1;
  }
  return adjustment;
}

/**
 * Vote yes/no off the player's own (fair) margin estimate, via
 * marginToVoteYesProbability, plus roundSensitiveVoteAdjustment for Dying God.
 * Otherwise deliberately ignores the round: whether to end is a fresh decision every
 * time voting comes up, not a countdown; the round cap already force-ends the game on
 * its own once reached, so there's no separate need to ramp pressure by round here too.
 */
export function computeAiVote(state: GameState, playerId: string, rng: () => number): boolean {
  const margin = estimateMargin(state, playerId) + roundSensitiveVoteAdjustment(state, playerId);
  return rng() < marginToVoteYesProbability(margin);
}
