import { BOARD_BOUNDS_BY_PLAYER_COUNT } from "@/lib/config/boardSizing";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { dealNewGame, Rng } from "./deck";
import { computeAiVote, computeGameResult, shouldEndGame } from "./endgame";
import { applyFlip, applyPass, applyPlace, currentPlayerId, mustPass } from "./turns";
import { CastVoteAction, GameAction, GameConfig, GameState } from "./types";

export function configForPlayerCount(playerCount: number): GameConfig {
  const boardBounds = BOARD_BOUNDS_BY_PLAYER_COUNT[playerCount];
  if (!boardBounds) throw new Error(`No board sizing configured for ${playerCount} players (supported: 2-6)`);
  return {
    boardBounds,
    handSize: 7,
    roundCap: 6,
    // 2p delays the flip unlock by a round -- with only one opponent, a single flip
    // removes all "unknown" for that card faster than in larger games.
    flipUnlockRound: playerCount === 2 ? 3 : 2,
    centerEffect: "none",
    minRoundFloor: 3,
    playerCount,
  };
}

export const DEFAULT_2P_CONFIG: GameConfig = configForPlayerCount(2);

export function createGame(
  playerIds: string[],
  config: GameConfig = DEFAULT_2P_CONFIG,
  rng?: Rng,
  aiPlayerIds: Iterable<string> = [],
  firstPlayerIndex = 0
): GameState {
  const { players, remainingDeck } = dealNewGame(playerIds, config.handSize, rng);
  const aiIds = new Set(aiPlayerIds);
  return {
    config,
    board: new Map(),
    deck: remainingDeck,
    players: players.map((p) => ({ ...p, isAI: aiIds.has(p.id) })),
    currentPlayerIndex: firstPlayerIndex,
    round: 1,
    turnsThisRound: 0,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    votes: {},
    placementOrder: [],
    phase: "playing",
    result: null,
  };
}

/**
 * Round-start hook for center effects that need one (currently just Reckoning).
 * Round 4 can be entered two different ways (see call sites below), so this is
 * factored out rather than duplicated. See lib/engine/centerEffects.ts.
 */
function applyRoundStart(state: GameState, newRound: number, rng: Rng): Pick<GameState, "players" | "deck"> {
  const onRoundStart = CENTER_EFFECTS[state.config.centerEffect].onRoundStart;
  if (onRoundStart) return onRoundStart(state, newRound, rng);
  return { players: state.players, deck: state.deck };
}

/**
 * Advances to the next player's turn after a place/pass action. Endgame triggers are
 * only checked at a round boundary (after every player has acted this round) — see
 * the LOCKED fairness rule in game_spec.md. Board-fill and the round cap end the game
 * unconditionally; otherwise, from the min-round floor on, every round boundary
 * triggers a vote (see applyCastVote) instead of continuing automatically.
 *
 * A round boundary is "turnsThisRound reaches player count", not "currentPlayerIndex
 * wraps to 0" -- turn order rotates continuously through indices and does not reset
 * to 0 each round, so with a non-zero starting player (see firstPlayerIndex) the old
 * index-based check fired after just one turn instead of after everyone had gone.
 */
function advanceTurn(state: GameState, rng: Rng): GameState {
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;
  const turnsThisRound = state.turnsThisRound + 1;

  if (turnsThisRound < state.players.length) {
    return { ...state, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false, turnsThisRound };
  }

  const completedRound = state.round;

  if (shouldEndGame(state.board, state.config.boardBounds, completedRound, state.config.roundCap)) {
    const playerIds = state.players.map((p) => p.id);
    const result = computeGameResult(state.board, state.config.boardBounds, completedRound, playerIds, state.config.centerEffect);
    return { ...state, phase: "ended", result, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false, turnsThisRound: 0 };
  }

  if (completedRound >= state.config.minRoundFloor) {
    // AI votes resolve immediately (no async input needed); human vote(s) stay
    // pending in `votes` until cast via a castVote action.
    const votes: Record<string, boolean> = {};
    for (const player of state.players) {
      if (player.isAI) votes[player.id] = computeAiVote(state, player.id, rng);
    }
    return { ...state, phase: "voting", votes, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false, turnsThisRound: 0 };
  }

  const nextRound = completedRound + 1;
  const roundStart = applyRoundStart(state, nextRound, rng);
  return { ...state, ...roundStart, currentPlayerIndex: nextIndex, round: nextRound, hasFlippedThisTurn: false, turnsThisRound: 0 };
}

/**
 * Simultaneous private commit, tally when everyone's voted. Tie -> continue (ending
 * is the disruptive action, needs a real majority) -- at 2p this means consensus.
 */
function applyCastVote(state: GameState, action: CastVoteAction, rng: Rng): GameState {
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
    const result = computeGameResult(state.board, state.config.boardBounds, state.round, playerIds, state.config.centerEffect);
    return { ...state, phase: "ended", result, votes };
  }

  // currentPlayerIndex is left as-is -- advanceTurn already set it to the correct next
  // player (turn order rotates continuously, it doesn't reset to 0 each round). This is
  // the *default* path into a new round (minRoundFloor is 3 by default), so it needs
  // the same Reckoning check as advanceTurn's plain continue-branch.
  const nextRound = state.round + 1;
  const roundStart = applyRoundStart(state, nextRound, rng);
  return { ...state, ...roundStart, phase: "playing", votes: {}, round: nextRound, hasFlippedThisTurn: false };
}

/** Pure reducer: applyAction(state, action) -> state. Throws on illegal actions. */
export function applyAction(state: GameState, action: GameAction, rng: Rng = Math.random): GameState {
  if (state.phase === "ended") throw new Error("Game has already ended");

  // Voting isn't tied to turn order -- any player who hasn't voted yet may cast one,
  // independent of whose turn it currently is.
  if (action.type === "castVote") return applyCastVote(state, action, rng);

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
