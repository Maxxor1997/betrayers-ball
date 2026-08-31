import { getAdjacentCards, getLegalPlacementPositions, isOwnerlessPosition, parsePosKey } from "./board";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { Board, BoardBounds, CardInstance, FlipAction, GameConfig, GameState, PlaceAction, Position, posKey } from "./types";

/** True if `pos` is adjacent to a card whose def blocks its neighbors from being flipped (e.g. Cyclops). */
function isFlipBlockedAt(board: Board, bounds: BoardBounds, pos: Position): boolean {
  return getAdjacentCards(board, bounds, pos).some((n) => CARD_DEFS[n.cardId].blocksAdjacentFlips);
}

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
 * Any face-down card on the board, any owner — the legal flip targets right now.
 * Except a card marked `opponentOnlyFlip` (see lib/content/cards.ts): its own owner
 * can't flip it, only an opponent can. A center effect can further narrow this via
 * `flipTargetFilter` (unused by any current effect).
 */
export function getLegalFlipTargets(state: GameState): CardInstance[] {
  if (state.phase !== "playing") return [];
  if (!isFlipUnlocked(state.round, state.config)) return [];
  if (state.hasFlippedThisTurn) return [];
  const flipperId = currentPlayerId(state);
  const bounds = state.config.boardBounds;
  const targets = [...state.board.entries()]
    .filter(
      ([, c]) => !c.faceUp && !(CARD_DEFS[c.cardId].opponentOnlyFlip && c.ownerId === flipperId)
    )
    .filter(([key]) => !isFlipBlockedAt(state.board, bounds, parsePosKey(key)))
    .map(([, c]) => c);
  const flipTargetFilter = CENTER_EFFECTS[state.config.centerEffect].flipTargetFilter;
  if (flipTargetFilter) return flipTargetFilter(targets, flipperId);
  return targets;
}

/** Empty board cells a card could legally be placed on right now. */
export function getLegalPlacementCells(state: GameState): Position[] {
  if (state.phase !== "playing") return [];
  const anywhere = CENTER_EFFECTS[state.config.centerEffect].placementAnywhere;
  return getLegalPlacementPositions(state.board, state.config.boardBounds, { anywhere });
}

/**
 * Which of a player's hand cards are actually legal to place right now -- normally
 * the player's whole hand, but Hall of Fortunes restricts it to that player's current
 * 3-card offer (see GameState.handOffers), which for that location IS the player's
 * whole hand at any moment (see deck.ts's redrawOffer) -- there's no larger fixed hand
 * behind it. Every legality check and AI/UI "which cards can I place" call site should
 * read hand-candidates through this, not `player.hand` directly.
 *
 * At Hall of Fortunes specifically, a player's offer is deleted the moment they place
 * the offered card (see applyPlace) and isn't redrawn until their next turn actually
 * starts (see game.ts's redrawOfferForCurrentPlayer) -- so for the whole stretch of
 * opponents' turns in between, there's genuinely no live offer for them yet. Falling
 * back to their full hand in that gap (like the non-Reckoning branch below correctly
 * does) would leak their still-unreturned leftover cards on their own screen between
 * turns -- an empty offer is the correct, honest answer there, not a fallback.
 */
export function offeredCardsFor(state: GameState, playerId: string): CardInstance[] {
  if (state.config.centerEffect !== "reckoning") {
    const player = state.players.find((p) => p.id === playerId);
    return player?.hand ?? [];
  }
  return state.handOffers[playerId] ?? [];
}

/** True if the current player has no legal move and must pass this turn. */
export function mustPass(state: GameState): boolean {
  const player = state.players[state.currentPlayerIndex];
  if (offeredCardsFor(state, player.id).length === 0) return true;
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
  if (CARD_DEFS[target.cardId].opponentOnlyFlip && target.ownerId === action.playerId) {
    throw new Error(`${CARD_DEFS[target.cardId].name} can only be flipped by an opponent, not its own owner`);
  }
  if (isFlipBlockedAt(state.board, state.config.boardBounds, parsePosKey(key))) {
    throw new Error(`${CARD_DEFS[target.cardId].name} cannot be flipped while adjacent to a ${CARD_DEFS.Giant.name}`);
  }
  const flipTargetFilter = CENTER_EFFECTS[state.config.centerEffect].flipTargetFilter;
  if (flipTargetFilter && flipTargetFilter([target], action.playerId).length === 0) {
    throw new Error(`${CENTER_EFFECTS[state.config.centerEffect].label}: you cannot flip that card`);
  }

  const board = new Map(state.board);
  board.set(key, { ...target, faceUp: true });

  const flipHistory = [
    ...state.flipHistory,
    { round: state.round, playerId: action.playerId, ownerId: target.ownerId, instanceId: target.instanceId, cardId: target.cardId },
  ];

  return { ...state, board, hasFlippedThisTurn: true, flipHistory };
}

export function applyPlace(state: GameState, action: PlaceAction): GameState {
  requireCurrentPlayer(state, action.playerId);

  const player = state.players[state.currentPlayerIndex];
  const handIndex = player.hand.findIndex((c) => c.instanceId === action.instanceId);
  if (handIndex === -1) throw new Error(`${action.playerId} has no card ${action.instanceId} in hand`);
  const card = player.hand[handIndex];

  const offer = state.handOffers[action.playerId];
  if (offer && !offer.some((c) => c.instanceId === action.instanceId)) {
    throw new Error(`${CENTER_EFFECTS[state.config.centerEffect].label}: that card isn't one of your currently offered options`);
  }

  const bounds = state.config.boardBounds;
  if (isOwnerlessPosition(action.position, bounds)) throw new Error("Cannot place on the center tile");
  const anywhere = CENTER_EFFECTS[state.config.centerEffect].placementAnywhere;
  const legalCells = getLegalPlacementPositions(state.board, bounds, { anywhere });
  const isLegal = legalCells.some((p) => posKey(p) === posKey(action.position));
  if (!isLegal) throw new Error(`Position ${posKey(action.position)} is not a legal placement`);

  const board = new Map(state.board);
  const def = CARD_DEFS[card.cardId];
  // A card can force itself face-up on placement -- a placement/state rule, not a
  // scoring effect.
  const faceUp = def.forceFaceUp ? true : card.faceUp;
  board.set(posKey(action.position), { ...card, faceUp });

  // A card's placement-time trigger, distinct from the turn's normal optional flip
  // action -- it doesn't consume hasFlippedThisTurn and ignores the flip-lock rules
  // above (those gate the *player's* flip action, not a card's own printed effect).
  // Also unaffected by negation, which in this engine is a resolution-time-only
  // concept, not something computed mid-game during turns.
  def.onPlace?.({ board, bounds, pos: action.position });

  const players = state.players.map((p, i) =>
    i === state.currentPlayerIndex ? { ...p, hand: [...p.hand.slice(0, handIndex), ...p.hand.slice(handIndex + 1)] } : p
  );

  let handOffers = state.handOffers;
  if (offer) {
    handOffers = { ...state.handOffers };
    delete handOffers[action.playerId];
  }

  return { ...state, board, players, placementOrder: [...state.placementOrder, card.instanceId], handOffers };
}

export function applyPass(state: GameState, playerId: string): GameState {
  requireCurrentPlayer(state, playerId);
  if (!mustPass(state)) throw new Error(`${playerId} has a legal move and cannot pass`);
  return state;
}
