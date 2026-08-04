export type CardId =
  | "Footman"
  | "Giant"
  | "Warlord"
  | "Exile"
  | "Pretender"
  | "Berserker"
  | "Commander"
  | "Champion"
  | "Darkspawn"
  | "Chronicler"
  | "Earthshaker"
  | "Skysplitter"
  | "Bannerman"
  | "PlagueBearer"
  | "Suppressor"
  | "Headsman";

export type CardBucket = "Slam" | "Engine" | "Control";

export interface CardDef {
  id: CardId;
  name: string;
  base: number;
  bucket: CardBucket;
}

/** A card before it's been dealt to a player — no owner yet. */
export interface DeckCard {
  instanceId: string;
  cardId: CardId;
}

/** A card that has been dealt to a player (in hand or on the board). */
export interface CardInstance extends DeckCard {
  ownerId: string;
  faceUp: boolean;
}

export interface Position {
  x: number;
  y: number;
}

/** Board is a coordinate map, not a 2D array — see CLAUDE.md core invariants. */
export type Board = Map<string, CardInstance>;

export interface BoardBounds {
  width: number;
  height: number;
  /** Position of the center tile, pinned at the true middle. */
  center: Position;
}

export interface PlayerState {
  id: string;
  hand: CardInstance[];
  isAI: boolean;
}

export type CenterEffectId = "none";

export interface GameConfig {
  boardBounds: BoardBounds;
  handSize: number;
  roundCap: number;
  flipUnlockRound: number;
  centerEffect: CenterEffectId;
}

export interface GameResult {
  scores: Record<string, number>;
  winnerIds: string[];
}

export interface GameState {
  config: GameConfig;
  board: Board;
  players: PlayerState[];
  currentPlayerIndex: number;
  round: number;
  /** Players who had no legal placement and are passing for the rest of the game. */
  passedPlayerIds: Set<string>;
  hasFlippedThisTurn: boolean;
  phase: "playing" | "ended";
  result: GameResult | null;
}

export interface FlipAction {
  type: "flip";
  playerId: string;
  instanceId: string;
}

export interface PlaceAction {
  type: "place";
  playerId: string;
  instanceId: string;
  position: Position;
}

export interface PassAction {
  type: "pass";
  playerId: string;
}

export type GameAction = FlipAction | PlaceAction | PassAction;

export function posKey(pos: Position): string {
  return `${pos.x},${pos.y}`;
}
