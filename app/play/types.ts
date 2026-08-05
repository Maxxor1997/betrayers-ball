import { ResolvedCard } from "@/lib/engine/resolution";
import { CardInstance, CenterEffectId, GameState, Position } from "@/lib/engine/types";

/** Player count and center effect chosen from the "New game" setup popup. */
export interface NewGameSetup {
  playerCount: number;
  centerEffect: CenterEffectId | "random";
}

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
  disabled: boolean;
}

export interface PlayerTableProps {
  label: string;
  score: number;
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
