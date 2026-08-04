import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells } from "../engine/turns";
import { GameAction, GameState } from "../engine/types";

export type Rng = () => number;

const DEFAULT_FLIP_PROBABILITY = 0.3;

/**
 * Chooses one legal action for `playerId`'s current decision point. A turn is a
 * sequence of up to two calls: first (maybe) a flip, then always a place-or-pass —
 * flip doesn't end the turn, so the caller should call this again after a flip
 * action to get the place/pass action that follows.
 */
export function chooseAiAction(
  state: GameState,
  playerId: string,
  rng: Rng = Math.random,
  flipProbability = DEFAULT_FLIP_PROBABILITY
): GameAction {
  if (playerId !== currentPlayerId(state)) {
    throw new Error(`It is not ${playerId}'s turn`);
  }

  const flipTargets = getLegalFlipTargets(state);
  if (flipTargets.length > 0 && rng() < flipProbability) {
    const target = flipTargets[Math.floor(rng() * flipTargets.length)];
    return { type: "flip", playerId, instanceId: target.instanceId };
  }

  const player = state.players[state.currentPlayerIndex];
  const legalCells = getLegalPlacementCells(state);
  if (player.hand.length === 0 || legalCells.length === 0) {
    return { type: "pass", playerId };
  }

  const cell = legalCells[Math.floor(rng() * legalCells.length)];
  const card = player.hand[Math.floor(rng() * player.hand.length)];
  return { type: "place", playerId, instanceId: card.instanceId, position: cell };
}
