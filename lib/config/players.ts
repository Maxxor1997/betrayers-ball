export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export const AI_NAMES = [
  "Sir Loin of Beef",
  "Baron von Bluffalo",
  "Duchess Doomscroll",
  "Count Cardigan",
  "Earl of Awkward",
  "Viscount Vibecheck",
  "Marquess of Mischief",
];

export const PLAYER_COLOR_CLASSES = [
  "border-blue-500 bg-blue-50 dark:bg-blue-950",
  "border-red-500 bg-red-50 dark:bg-red-950",
  "border-purple-500 bg-purple-50 dark:bg-purple-950",
  "border-orange-500 bg-orange-50 dark:bg-orange-950",
  "border-teal-500 bg-teal-50 dark:bg-teal-950",
  "border-pink-500 bg-pink-50 dark:bg-pink-950",
  "border-lime-500 bg-lime-50 dark:bg-lime-950",
  "border-cyan-500 bg-cyan-50 dark:bg-cyan-950",
];

// Same order/palette as PLAYER_COLOR_CLASSES, as plain text colors for the end screen.
export const PLAYER_TEXT_COLOR_CLASSES = [
  "text-blue-600 dark:text-blue-400",
  "text-red-600 dark:text-red-400",
  "text-purple-600 dark:text-purple-400",
  "text-orange-600 dark:text-orange-400",
  "text-teal-600 dark:text-teal-400",
  "text-pink-600 dark:text-pink-400",
  "text-lime-600 dark:text-lime-400",
  "text-cyan-600 dark:text-cyan-400",
];

// Same order again, as a left-border accent color for the end screen's per-player tables.
export const PLAYER_BORDER_COLOR_CLASSES = [
  "border-blue-500",
  "border-red-500",
  "border-purple-500",
  "border-orange-500",
  "border-teal-500",
  "border-pink-500",
  "border-lime-500",
  "border-cyan-500",
];

// Same order again, as a solid dot color -- for compact legend/indicator swatches (e.g. CardCatalog's "My Cards" key) too small for a border+fill treatment.
export const PLAYER_DOT_COLOR_CLASSES = [
  "bg-blue-500",
  "bg-red-500",
  "bg-purple-500",
  "bg-orange-500",
  "bg-teal-500",
  "bg-pink-500",
  "bg-lime-500",
  "bg-cyan-500",
];

/**
 * Index-based accent classes for a given player's own cards -- the single source of
 * truth every UI that needs "this player's color" pulls from (Board's owned-card
 * styling, Hand's card border, CardCatalog's "My Cards" highlight, ...), so a card
 * looks the same color in your hand, on the board, and in the catalog no matter which
 * seat you happen to be. Index-based (not identity-based) so the same seat position
 * always gets the same color regardless of who -- human, AI, or which real player --
 * sits there; see Board.tsx's ownerColorClass, this function's original home before it
 * needed to be shared with non-board UI too.
 */
export function playerAccentClass(players: { id: string }[], playerId: string): string {
  const idx = players.findIndex((p) => p.id === playerId);
  return PLAYER_COLOR_CLASSES[idx] ?? "border-zinc-400 bg-zinc-50 dark:bg-zinc-900";
}

/** Same indexing as playerAccentClass, for a solid-dot swatch instead of a border+fill box. */
export function playerDotColorClass(players: { id: string }[], playerId: string): string {
  const idx = players.findIndex((p) => p.id === playerId);
  return PLAYER_DOT_COLOR_CLASSES[idx] ?? "bg-zinc-400";
}
