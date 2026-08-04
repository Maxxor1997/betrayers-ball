import { dealNewGame } from "./deck";
import { computeGameResult, shouldEndGame } from "./endgame";
import { applyFlip, applyPass, applyPlace, currentPlayerId, mustPass } from "./turns";
import { GameAction, GameConfig, GameState } from "./types";

export const DEFAULT_2P_CONFIG: GameConfig = {
  boardBounds: { width: 5, height: 3, center: { x: 2, y: 1 } },
  handSize: 7,
  roundCap: 6,
  flipUnlockRound: 2,
  centerEffect: "none",
  minRoundFloor: 3,
};

export function createGame(playerIds: string[], config: GameConfig = DEFAULT_2P_CONFIG, rng?: () => number): GameState {
  const { players } = dealNewGame(playerIds, config.handSize, rng);
  return {
    config,
    board: new Map(),
    players,
    currentPlayerIndex: 0,
    round: 1,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    endRequested: false,
    placementOrder: [],
    phase: "playing",
    result: null,
  };
}

/** Earliest round an end-game request is allowed, and whether one hasn't already landed. */
export function canRequestEnd(state: GameState): boolean {
  return state.phase === "playing" && !state.endRequested && state.round >= state.config.minRoundFloor;
}

/**
 * Advances to the next player's turn after a place/pass action. Endgame triggers are
 * only checked at a round boundary (after every player has acted this round) — see
 * the LOCKED fairness rule in game_spec.md. Voting is deferred for this pass, so the
 * only triggers wired up are the turn/round cap and board-fill.
 */
function advanceTurn(state: GameState): GameState {
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;

  if (nextIndex !== 0) {
    return { ...state, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false };
  }

  const completedRound = state.round;
  if (shouldEndGame(state.board, state.config.boardBounds, completedRound, state.config.roundCap, state.endRequested)) {
    const playerIds = state.players.map((p) => p.id);
    const result = computeGameResult(state.board, state.config.boardBounds, completedRound, playerIds);
    return { ...state, phase: "ended", result, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false };
  }

  return { ...state, currentPlayerIndex: nextIndex, round: completedRound + 1, hasFlippedThisTurn: false };
}

function applyRequestEnd(state: GameState, playerId: string): GameState {
  if (!state.players.some((p) => p.id === playerId)) throw new Error(`Unknown player ${playerId}`);
  if (state.round < state.config.minRoundFloor) {
    throw new Error(`Cannot request end before round ${state.config.minRoundFloor}`);
  }
  if (state.endRequested) return state;
  return { ...state, endRequested: true };
}

/** Pure reducer: applyAction(state, action) -> state. Throws on illegal actions. */
export function applyAction(state: GameState, action: GameAction): GameState {
  if (state.phase !== "playing") throw new Error("Game has already ended");

  // requestEnd isn't tied to turn order -- any player can ask for the game to end at
  // the next round boundary, independent of whose turn it currently is.
  if (action.type === "requestEnd") return applyRequestEnd(state, action.playerId);

  if (action.playerId !== currentPlayerId(state)) throw new Error(`It is not ${action.playerId}'s turn`);

  switch (action.type) {
    case "flip":
      return applyFlip(state, action);
    case "place":
      return advanceTurn(applyPlace(state, action));
    case "pass":
      return advanceTurn(applyPass(state, action.playerId));
    default:
      throw new Error(`Unknown action type: ${(action as GameAction).type}`);
  }
}

export { mustPass };
