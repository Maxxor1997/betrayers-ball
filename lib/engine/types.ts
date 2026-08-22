export type CardId =
  | "Footman"
  | "Giant"
  | "Warlord"
  | "Exile"
  | "Pretender"
  | "Berserker"
  | "Commander"
  | "Gloryseeker"
  | "Chronicler"
  | "Earthshaker"
  | "Skysplitter"
  | "Bannerman"
  | "PlagueBearer"
  | "Suppressor"
  | "Infiltrator"
  | "Truthseeker"
  | "Mercenary"
  | "DyingGod"
  | "Beacon"
  | "PlagueRat"
  /**
   * Synthetic, non-drawable placeholder for "an opponent's face-down card I can't
   * identify" -- used only by estimateMargin's fair evaluation board (see
   * UNKNOWN_CARD_PLACEHOLDER in endgame.ts), never dealt into a real deck. Excluded
   * from every UI listing of real cards (see the ALL_CARD_IDS filter in play/page.tsx).
   */
  | "Unknown";

export type CardBucket = "Slam" | "Engine" | "Control";

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
  /**
   * The full set of ownerless, unplaceable tiles for the active center effect --
   * counts as occupied neighbors for adjacency purposes. Defaults to `[center]` when
   * absent (the common case). An effect can override this entirely: Three Headed
   * Dragon adds two extra tiles alongside center, Two Towers moves the tiles off
   * center altogether.
   */
  ownerless?: Position[];
}

export interface PlayerState {
  id: string;
  hand: CardInstance[];
  isAI: boolean;
}

export type CenterEffectId =
  | "none"
  | "mirrorPool"
  | "championOfTheWeak"
  | "kingslayer"
  | "shadowlands"
  | "reckoning"
  | "threeHeadedDragon"
  | "twoTowers"
  | "freeCities"
  | "frontier"
  | "summit";

/**
 * Which strategy module an AI seat's turns are computed by -- see
 * lib/ai/difficulty.ts's chooseAiActionForDifficulty, the single dispatcher every
 * AI-turn call site should go through instead of importing a specific strategy module
 * directly. "easy" is uniform-random, "medium" is a 1-ply greedy evaluator with
 * per-card heuristic patches (see lib/ai/greedyAi.ts), "hard" (see lib/ai/twoPly.ts)
 * extends "medium"'s placement decision one real ply further -- for each of a pruned
 * set of candidate placements, it simulates a full round of every opponent's actual
 * response (via "medium"'s own decision function) against a determinized guess at
 * hidden cards, and picks whichever candidate's simulated outcome averages best.
 * "expert" (see lib/ai/hardFast.ts) is the same idea at the same wall-clock budget,
 * but with a much cheaper (and deliberately less accurate) rollout for simulating
 * those responses -- AI-Arena-validated to beat "hard" head-to-head at the same
 * budget by reinvesting the savings into evaluating more candidate placements.
 */
export type AiDifficulty = "easy" | "medium" | "hard" | "expert";

export interface GameConfig {
  boardBounds: BoardBounds;
  handSize: number;
  roundCap: number;
  flipUnlockRound: number;
  centerEffect: CenterEffectId;
  /** Earliest round a vote can be called, per the spec's min-round floor. */
  minRoundFloor: number;
  /** Number of players -- affects flip rules (see isFlipUnlocked in turns.ts): 2p
   * delays the normal flip unlock by a round, since with only one opponent a single
   * flip removes all "unknown" for that card faster than in larger games. Shadowlands
   * (see centerEffects.ts's flipGate) delays it a further round on top of that,
   * regardless of player count. */
  playerCount: number;
  /** Which strategy every AI seat in this game uses -- see AiDifficulty's doc comment. */
  aiDifficulty: AiDifficulty;
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
  /** Every completed voting round's tally, oldest first -- `votes` only holds the
   * current/most recent round, so this is what a post-game "how did each round's vote
   * go" summary reads from. A round is appended here as soon as its tally resolves
   * (everyone's voted), whether it passed or not. */
  voteHistory: { round: number; votes: Record<string, boolean> }[];
  /**
   * Every card a player chose to flip face-up, oldest first -- a genuine reveal
   * decision, not a card that started face-up because it was placed that way (Giant,
   * Truthseeker's forceFaceUp) or flipped as someone else's side effect (Truthseeker's
   * onPlace). `playerId` is who did the flipping; `ownerId` is who the flipped card
   * belongs to -- these differ whenever a player blind-flips an *opponent's* face-down
   * card (a legal move -- see getLegalFlipTargets), not just their own. Drives a "what
   * has each opponent flipped" summary UI.
   */
  flipHistory: { round: number; playerId: string; ownerId: string; instanceId: string; cardId: CardId }[];
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
