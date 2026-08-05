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
  /** Short human-readable effect summary, for hand/board UI. */
  text: string;
  /** Full effect description, matching game_spec.md's wording -- for hover tooltips. */
  fullText: string;
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

export type CenterEffectId =
  | "none"
  | "noMansLand"
  | "mirrorPool"
  | "championOfTheWeak"
  | "kingslayer"
  | "shadowlands"
  | "reckoning";

export interface GameConfig {
  boardBounds: BoardBounds;
  handSize: number;
  roundCap: number;
  flipUnlockRound: number;
  centerEffect: CenterEffectId;
  /** Earliest round a vote can be called, per the spec's min-round floor. */
  minRoundFloor: number;
}

export interface GameResult {
  scores: Record<string, number>;
  winnerIds: string[];
}

export interface GameState {
  config: GameConfig;
  board: Board;
  /**
   * The undrawn pool left after the initial deal. Unused by most games (hands are
   * fixed for the game per the spec) -- only consumed by the Reckoning center effect,
   * which redraws hands at round 4.
   */
  deck: DeckCard[];
  players: PlayerState[];
  currentPlayerIndex: number;
  round: number;
  /**
   * How many players have taken a turn since this round started. Turn order rotates
   * continuously through player indices (it does not reset to 0 each round), so this
   * -- not `currentPlayerIndex === 0` -- is what actually marks a round boundary;
   * that matters once the starting player can be anyone (see firstPlayerIndex).
   */
  turnsThisRound: number;
  /** Players who had no legal placement and are passing for the rest of the game. */
  passedPlayerIds: Set<string>;
  hasFlippedThisTurn: boolean;
  /**
   * Votes cast in the current voting round (playerId -> end/continue). Empty when
   * phase isn't "voting". AI votes are filled in immediately when voting opens;
   * human vote(s) stay pending until a castVote action arrives.
   */
  votes: Record<string, boolean>;
  /** instanceIds in the order they were placed on the board — for turn-order UI/history. */
  placementOrder: string[];
  phase: "playing" | "voting" | "ended";
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

/**
 * A single player's vote in the current voting round (LOCKED protocol: simultaneous
 * private commit, tallied once everyone's voted — tie means continue). `vote: true`
 * means "end the game now".
 */
export interface CastVoteAction {
  type: "castVote";
  playerId: string;
  vote: boolean;
}

export type GameAction = FlipAction | PlaceAction | PassAction | CastVoteAction;

export function posKey(pos: Position): string {
  return `${pos.x},${pos.y}`;
}
