import { Board, CardId } from "./types";

/**
 * What a given player can see about a board cell. This is the projection a real
 * multiplayer client would be sent -- see board_game_design.md's "different clients
 * render different slices" architecture. Scoped to the board for now (what's needed
 * today, for fair AI evaluation); a fuller GameState-level view (own hand vs.
 * opponents' hand *sizes* only, etc.) is the natural next step once real client/server
 * networking gets built.
 */
export interface VisibleCard {
  instanceId: string;
  ownerId: string;
  faceUp: boolean;
  /** null if this card's identity isn't visible to the viewer. */
  cardId: CardId | null;
}

/** A cell is known to `viewerId` if it's face-up (visible to everyone) or they own it
 * (they placed it, they know what it is) -- otherwise its identity is withheld. */
export function getVisibleBoard(board: Board, viewerId: string): Map<string, VisibleCard> {
  const visible = new Map<string, VisibleCard>();
  for (const [key, card] of board.entries()) {
    const known = card.faceUp || card.ownerId === viewerId;
    visible.set(key, {
      instanceId: card.instanceId,
      ownerId: card.ownerId,
      faceUp: card.faceUp,
      cardId: known ? card.cardId : null,
    });
  }
  return visible;
}
