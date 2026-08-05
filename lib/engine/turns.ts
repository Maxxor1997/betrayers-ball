import { getLegalPlacementPositions, isOwnerlessPosition } from "./board";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { CardInstance, FlipAction, GameConfig, GameState, PlaceAction, Position, posKey } from "./types";

export function currentPlayerId(state: GameState): string {
  return state.players[state.currentPlayerIndex].id;
}

function requireCurrentPlayer(state: GameState, playerId: string): void {
  if (state.phase !== "playing") throw new Error("Game has already ended");
  if (playerId !== currentPlayerId(state)) throw new Error(`It is not ${playerId}'s turn`);
}

/**
 * Whether flipping is allowed on this round. Normally any round from
 * `flipUnlockRound` on (2p delays this to round 3 -- see configForPlayerCount). A
 * center effect can override via `flipGate` (unused by any current effect).
 */
export function isFlipUnlocked(round: number, config: GameConfig): boolean {
  const flipGate = CENTER_EFFECTS[config.centerEffect].flipGate;
  if (flipGate) return flipGate(round, config);
  return round >= config.flipUnlockRound;
}

/**
 * Any face-down card on the board, any owner — the legal flip targets right now. A
 * center effect can narrow this via `flipTargetFilter` (unused by any current effect).
 */
export function getLegalFlipTargets(state: GameState): CardInstance[] {
  if (state.phase !== "playing") return [];
  if (!isFlipUnlocked(state.round, state.config)) return [];
  if (state.hasFlippedThisTurn) return [];
  const targets = [...state.board.values()].filter((c) => !c.faceUp);
  const flipTargetFilter = CENTER_EFFECTS[state.config.centerEffect].flipTargetFilter;
  if (flipTargetFilter) return flipTargetFilter(targets, currentPlayerId(state));
  return targets;
}

/** Empty board cells a card could legally be placed on right now. */
export function getLegalPlacementCells(state: GameState): Position[] {
  if (state.phase !== "playing") return [];
  const anywhere = CENTER_EFFECTS[state.config.centerEffect].placementAnywhere;
  return getLegalPlacementPositions(state.board, state.config.boardBounds, { anywhere });
}

/** True if the current player has no legal move and must pass this turn. */
export function mustPass(state: GameState): boolean {
  const player = state.players[state.currentPlayerIndex];
  if (player.hand.length === 0) return true;
  return getLegalPlacementCells(state).length === 0;
}

export function applyFlip(state: GameState, action: FlipAction): GameState {
  requireCurrentPlayer(state, action.playerId);
  if (!isFlipUnlocked(state.round, state.config)) {
    throw new Error(`Flipping is not allowed on round ${state.round}`);
  }
  if (state.hasFlippedThisTurn) throw new Error("Already flipped a card this turn");

  const entry = [...state.board.entries()].find(([, c]) => c.instanceId === action.instanceId);
  if (!entry) throw new Error(`No card ${action.instanceId} on the board`);
  const [key, target] = entry;
  if (target.faceUp) throw new Error("Card is already face-up");
  const flipTargetFilter = CENTER_EFFECTS[state.config.centerEffect].flipTargetFilter;
  if (flipTargetFilter && flipTargetFilter([target], action.playerId).length === 0) {
    throw new Error(`${CENTER_EFFECTS[state.config.centerEffect].label}: you cannot flip that card`);
  }

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
  if (isOwnerlessPosition(action.position, bounds)) throw new Error("Cannot place on the center tile");
  const anywhere = CENTER_EFFECTS[state.config.centerEffect].placementAnywhere;
  const legalCells = getLegalPlacementPositions(state.board, bounds, { anywhere });
  const isLegal = legalCells.some((p) => posKey(p) === posKey(action.position));
  if (!isLegal) throw new Error(`Position ${posKey(action.position)} is not a legal placement`);

  const board = new Map(state.board);
  const def = CARD_DEFS[card.cardId];
  // A card can force itself face-up on placement (e.g. Giant) — a placement/state
  // rule, not a scoring effect.
  const faceUp = def.forceFaceUp ? true : card.faceUp;
  board.set(posKey(action.position), { ...card, faceUp });

  // A card's placement-time trigger (e.g. Truthseeker flipping adjacent cards),
  // distinct from the turn's normal optional flip action -- it doesn't consume
  // hasFlippedThisTurn and ignores the flip-lock rules above (those gate the
  // *player's* flip action, not a card's own printed effect). Also unaffected by
  // Suppressor negation, which in this engine is a resolution-time-only concept,
  // not something computed mid-game during turns.
  def.onPlace?.({ board, bounds, pos: action.position });

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
