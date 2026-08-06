import { ResolvedCard } from "@/lib/engine/resolution";
import { CardId, CardInstance, GameState, Position } from "@/lib/engine/types";

export type { NewGameSetup } from "@/app/components/NewGameModal";

/** A flip the human has tapped/clicked but not yet confirmed. */
export interface PendingFlip {
  instanceId: string;
  label: string;
}

export interface BoardGridProps {
  state: GameState;
  legalCellKeys: Set<string>;
  flipTargetIds: Set<string>;
  selectedInstanceId: string | null;
  dragOverKey: string | null;
  revealAll: boolean;
  /** Scoring breakdown per instanceId, once the game has ended -- see EndScreen. */
  resolvedCards?: Map<string, ResolvedCard>;
  /** Card type currently hovered in the hand (see HandProps.onHoverCardId) -- every
   * board card of this type whose identity is visible to the viewer gets highlighted,
   * so e.g. hovering a Warlord in hand shows every Warlord already on the board. */
  highlightedCardId: CardId | null;
  onCellClick: (pos: Position) => void;
  onCellDragOver: (e: React.DragEvent, key: string) => void;
  onCellDragLeave: () => void;
  onCellDrop: (e: React.DragEvent, pos: Position) => void;
}

export interface HandProps {
  cards: CardInstance[];
  selectedInstanceId: string | null;
  onCardClick: (instanceId: string) => void;
  onCardDragStart: (e: React.DragEvent, instanceId: string) => void;
  /** Fires as the mouse enters/leaves a hand card, with that card's type (or null on
   * leave) -- lets the board highlight matching cards elsewhere. */
  onHoverCardId: (cardId: CardId | null) => void;
  disabled: boolean;
}

export interface PlayerTableProps {
  label: string;
  score: number;
  /** e.g. "1st place" or "Tied for 2nd place" -- see EndScreen's ranking computation. */
  placeLabel: string;
  /** Visually sets this player's table apart from the rest -- the human viewer's own row. */
  isYou: boolean;
  colorClass: string;
  borderColorClass: string;
  cards: ResolvedCard[];
  extraRow?: { label: string; value: number };
  /**
   * This player's vote in round N, keyed by round number -- approximates "the vote
   * taken right after this row's card was placed" by matching the card's row index
   * (1-based) to that round number. Exact when the player placed exactly one card per
   * round with no passes; if they ever passed, later rows drift from their true round.
   */
  votesByRound: Map<number, boolean>;
}
