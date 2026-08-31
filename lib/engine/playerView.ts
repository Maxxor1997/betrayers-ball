import { Board, CardInstance, GameState, PlayerState } from "./types";

/**
 * What a given player can see about a board cell. This is the projection a real
 * multiplayer client is sent -- see board_game_design.md's "different clients render
 * different slices" architecture.
 */
export interface VisibleCard {
  instanceId: string;
  ownerId: string;
  faceUp: boolean;
  /** null if this card's identity isn't visible to the viewer. */
  cardId: CardInstance["cardId"] | null;
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

/**
 * `getVisibleBoard`, but re-hydrated into a real Board (CardInstance map) instead of
 * the VisibleCard shell -- every card whose identity is hidden from `viewerId` becomes
 * the neutral, effect-free "Unknown" pseudo-card (see CARD_DEFS.Unknown) rather than a
 * `cardId: null` hole. That means every board-consuming piece -- AI margin estimation
 * (endgame.ts's estimateMargin, the original reason this existed), UI rendering, a
 * networked client's redacted state -- can keep working against an ordinary
 * Board/CardInstance shape with no separate "maybe-hidden" type threaded through the
 * app. The substitute card carries no printed effect of its own, so it's inert
 * wherever it lands; it can still be pushed around by *other* cards' effects (a
 * Bannerman neighbor, say), same as any real card.
 */
export function redactedBoardFor(board: Board, viewerId: string): Board {
  const visible = getVisibleBoard(board, viewerId);
  const redacted: Board = new Map();
  for (const [key, vc] of visible.entries()) {
    redacted.set(key, {
      instanceId: vc.instanceId,
      ownerId: vc.ownerId,
      faceUp: vc.faceUp,
      cardId: vc.cardId ?? "Unknown",
    });
  }
  return redacted;
}

/**
 * A full GameState redacted for one viewer -- what a real networked client is actually
 * allowed to receive (the server keeps the true, unredacted GameState for itself and
 * runs every reducer/AI decision against that; this is only ever built for an outgoing
 * push). Board cards go through `redactedBoardFor` -- *except* once the game has
 * ended, when the board is sent exactly as-is: "the board is revealed and scored" is
 * the game's own endgame rule (see game_spec.md/board_game_design.md), not a UI
 * convenience, so at that point there is nothing left to hide. Skipping redaction here
 * is what lets a networked client compute the same post-game breakdown
 * (`resolveBoard` against the real board) and reveal-all board rendering that
 * single-player already does. Every other player's hand is stripped to empty -- no
 * client-facing UI reads an opponent's hand contents or even its size today (unplayed
 * hand cards are never scored either, so the end-of-game breakdown doesn't need them),
 * and any server-side logic that needs real hand lengths (mustPass,
 * getLegalPlacementCells, ...) always runs against the true state, never this one.
 * `deck` (the undrawn pool) is dropped entirely for the same reason: nothing
 * client-facing reads it. The current voting round's `votes` is trimmed to just the
 * viewer's own entry (if cast) -- per the spec's locked simultaneous-commit protocol,
 * nobody's choice is visible to anyone else until the round tallies; `voteHistory`
 * (already-tallied rounds) is left intact since those are public by then.
 */
export function redactedStateFor(state: GameState, viewerId: string): GameState {
  const players: PlayerState[] = state.players.map((p) => (p.id === viewerId ? p : { ...p, hand: [] }));
  const votes = Object.fromEntries(Object.entries(state.votes).filter(([playerId]) => playerId === viewerId));
  const board = state.phase === "ended" ? state.board : redactedBoardFor(state.board, viewerId);
  // Hall of Fortunes' handOffers holds real CardInstance objects (with real cardId) --
  // same hidden-info rule as `hand` above, an opponent's offer must not leak over the
  // wire before it's played.
  const handOffers = Object.fromEntries(Object.entries(state.handOffers).filter(([playerId]) => playerId === viewerId));
  return {
    ...state,
    board,
    deck: [],
    players,
    votes,
    handOffers,
  };
}
