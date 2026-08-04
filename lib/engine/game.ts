import { dealNewGame, Rng } from "./deck";
import { aiVoteProbability, computeGameResult, shouldEndGame } from "./endgame";
import { applyFlip, applyPass, applyPlace, currentPlayerId, mustPass } from "./turns";
import { BoardBounds, CastVoteAction, GameAction, GameConfig, GameState } from "./types";

/**
 * Board sizing by player count, per game_spec.md's table (2-5p) extended to 6p using
 * the same pattern: height held at 5, width odd, usable cells (W*H-1) grows by 10 per
 * player (14, 24, 34, 44, 54...). Not in the spec — flagged there as "a later
 * extension" — so this 6p entry is an extrapolation, not a locked number.
 */
const BOARD_BOUNDS_BY_PLAYER_COUNT: Record<number, BoardBounds> = {
  2: { width: 5, height: 3, center: { x: 2, y: 1 } },
  3: { width: 5, height: 5, center: { x: 2, y: 2 } },
  4: { width: 7, height: 5, center: { x: 3, y: 2 } },
  5: { width: 9, height: 5, center: { x: 4, y: 2 } },
  6: { width: 11, height: 5, center: { x: 5, y: 2 } },
};

export function configForPlayerCount(playerCount: number): GameConfig {
  const boardBounds = BOARD_BOUNDS_BY_PLAYER_COUNT[playerCount];
  if (!boardBounds) throw new Error(`No board sizing configured for ${playerCount} players (supported: 2-6)`);
  return {
    boardBounds,
    handSize: 7,
    roundCap: 6,
    flipUnlockRound: 2,
    centerEffect: "none",
    minRoundFloor: 3,
  };
}

export const DEFAULT_2P_CONFIG: GameConfig = configForPlayerCount(2);

export function createGame(
  playerIds: string[],
  config: GameConfig = DEFAULT_2P_CONFIG,
  rng?: Rng,
  aiPlayerIds: Iterable<string> = []
): GameState {
  const { players } = dealNewGame(playerIds, config.handSize, rng);
  const aiIds = new Set(aiPlayerIds);
  return {
    config,
    board: new Map(),
    players: players.map((p) => ({ ...p, isAI: aiIds.has(p.id) })),
    currentPlayerIndex: 0,
    round: 1,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    votes: {},
    placementOrder: [],
    phase: "playing",
    result: null,
  };
}

/**
 * Advances to the next player's turn after a place/pass action. Endgame triggers are
 * only checked at a round boundary (after every player has acted this round) — see
 * the LOCKED fairness rule in game_spec.md. Board-fill and the round cap end the game
 * unconditionally; otherwise, from the min-round floor on, every round boundary
 * triggers a vote (see applyCastVote) instead of continuing automatically.
 */
function advanceTurn(state: GameState, rng: Rng): GameState {
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;

  if (nextIndex !== 0) {
    return { ...state, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false };
  }

  const completedRound = state.round;

  if (shouldEndGame(state.board, state.config.boardBounds, completedRound, state.config.roundCap)) {
    const playerIds = state.players.map((p) => p.id);
    const result = computeGameResult(state.board, state.config.boardBounds, completedRound, playerIds);
    return { ...state, phase: "ended", result, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false };
  }

  if (completedRound >= state.config.minRoundFloor) {
    // AI votes resolve immediately (no async input needed); human vote(s) stay
    // pending in `votes` until cast via a castVote action.
    const votes: Record<string, boolean> = {};
    for (const player of state.players) {
      if (player.isAI) votes[player.id] = rng() < aiVoteProbability(completedRound, state.config.roundCap);
    }
    return { ...state, phase: "voting", votes, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false };
  }

  return { ...state, currentPlayerIndex: nextIndex, round: completedRound + 1, hasFlippedThisTurn: false };
}

/**
 * Simultaneous private commit, tally when everyone's voted. Tie -> continue (ending
 * is the disruptive action, needs a real majority) -- at 2p this means consensus.
 */
function applyCastVote(state: GameState, action: CastVoteAction): GameState {
  if (state.phase !== "voting") throw new Error("No vote is currently in progress");
  if (!state.players.some((p) => p.id === action.playerId)) throw new Error(`Unknown player ${action.playerId}`);
  if (action.playerId in state.votes) throw new Error(`${action.playerId} has already voted`);

  const votes = { ...state.votes, [action.playerId]: action.vote };
  if (Object.keys(votes).length < state.players.length) {
    return { ...state, votes };
  }

  const yesCount = Object.values(votes).filter(Boolean).length;
  const passes = yesCount > state.players.length / 2;

  if (passes) {
    const playerIds = state.players.map((p) => p.id);
    const result = computeGameResult(state.board, state.config.boardBounds, state.round, playerIds);
    return { ...state, phase: "ended", result, votes };
  }

  return { ...state, phase: "playing", votes: {}, round: state.round + 1, currentPlayerIndex: 0, hasFlippedThisTurn: false };
}

/** Pure reducer: applyAction(state, action) -> state. Throws on illegal actions. */
export function applyAction(state: GameState, action: GameAction, rng: Rng = Math.random): GameState {
  if (state.phase === "ended") throw new Error("Game has already ended");

  // Voting isn't tied to turn order -- any player who hasn't voted yet may cast one,
  // independent of whose turn it currently is.
  if (action.type === "castVote") return applyCastVote(state, action);

  if (state.phase !== "playing") throw new Error("A vote is in progress");
  if (action.playerId !== currentPlayerId(state)) throw new Error(`It is not ${action.playerId}'s turn`);

  switch (action.type) {
    case "flip":
      return applyFlip(state, action);
    case "place":
      return advanceTurn(applyPlace(state, action), rng);
    case "pass":
      return advanceTurn(applyPass(state, action.playerId), rng);
    default:
      throw new Error(`Unknown action type: ${(action as GameAction).type}`);
  }
}

export { mustPass };
