import { getLegalPlacementPositions, isCenterPosition } from "./board";
import { CardInstance, FlipAction, GameState, PlaceAction, Position, posKey } from "./types";

export function currentPlayerId(state: GameState): string {
  return state.players[state.currentPlayerIndex].id;
}

function requireCurrentPlayer(state: GameState, playerId: string): void {
  if (state.phase !== "playing") throw new Error("Game has already ended");
  if (playerId !== currentPlayerId(state)) throw new Error(`It is not ${playerId}'s turn`);
}

/** Any face-down card on the board, any owner — the legal flip targets right now. */
export function getLegalFlipTargets(state: GameState): CardInstance[] {
  if (state.phase !== "playing") return [];
  if (state.round < state.config.flipUnlockRound) return [];
  if (state.hasFlippedThisTurn) return [];
  return [...state.board.values()].filter((c) => !c.faceUp);
}

/** Empty board cells a card could legally be placed on right now. */
export function getLegalPlacementCells(state: GameState): Position[] {
  if (state.phase !== "playing") return [];
  return getLegalPlacementPositions(state.board, state.config.boardBounds);
}

/** True if the current player has no legal move and must pass this turn. */
export function mustPass(state: GameState): boolean {
  const player = state.players[state.currentPlayerIndex];
  if (player.hand.length === 0) return true;
  return getLegalPlacementCells(state).length === 0;
}

export function applyFlip(state: GameState, action: FlipAction): GameState {
  requireCurrentPlayer(state, action.playerId);
  if (state.round < state.config.flipUnlockRound) {
    throw new Error(`Flipping unlocks at round ${state.config.flipUnlockRound}`);
  }
  if (state.hasFlippedThisTurn) throw new Error("Already flipped a card this turn");

  const entry = [...state.board.entries()].find(([, c]) => c.instanceId === action.instanceId);
  if (!entry) throw new Error(`No card ${action.instanceId} on the board`);
  const [key, target] = entry;
  if (target.faceUp) throw new Error("Card is already face-up");

  const board = new Map(state.board);
  board.set(key, { ...target, faceUp: true });

  return { ...state, board, hasFlippedThisTurn: true };
}

export function applyPlace(state: GameState, action: PlaceAction): GameState {
  requireCurrentPlayer(state, action.playerId);

  const player = state.players[state.currentPlayerIndex];
  const handIndex = player.hand.findIndex((c) => c.instanceId === action.instanceId);
  if (handIndex === -1) throw new Error(`${action.playerId} has no card ${action.instanceId} in hand`);
  const card = player.hand[handIndex];

  const bounds = state.config.boardBounds;
  if (isCenterPosition(action.position, bounds)) throw new Error("Cannot place on the center tile");
  const legalCells = getLegalPlacementPositions(state.board, bounds);
  const isLegal = legalCells.some((p) => posKey(p) === posKey(action.position));
  if (!isLegal) throw new Error(`Position ${posKey(action.position)} is not a legal placement`);

  const board = new Map(state.board);
  // Giant can't be played face-down — a placement/state rule, not a scoring effect.
  const faceUp = card.cardId === "Giant" ? true : card.faceUp;
  board.set(posKey(action.position), { ...card, faceUp });

  const players = state.players.map((p, i) =>
    i === state.currentPlayerIndex ? { ...p, hand: [...p.hand.slice(0, handIndex), ...p.hand.slice(handIndex + 1)] } : p
  );

  return { ...state, board, players, placementOrder: [...state.placementOrder, card.instanceId] };
}

export function applyPass(state: GameState, playerId: string): GameState {
  requireCurrentPlayer(state, playerId);
  if (!mustPass(state)) throw new Error(`${playerId} has a legal move and cannot pass`);
  return state;
}
