export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/**
 * The only lobby sizes offered when starting a game (NewGameModal) -- balance effort
 * is concentrated on these two configurations instead of spread across the whole
 * 2-8 range. Every player count in between MIN_PLAYERS/MAX_PLAYERS is still fully
 * supported by the engine (board sizing, deck counts, everything in cards.ts/
 * centerEffects.ts keeps its full per-player-count array in case this gets reopened
 * later) and by the playtest simulator's own player-count picker, which is
 * deliberately unrestricted -- this only narrows the two *lobby-creation* pickers.
 * A lobby started at either size backfills any unseated slots with AI once play
 * begins (see GameSession.start in lib/server/session.ts), same as solo play always
 * has.
 */
export const SELECTABLE_LOBBY_SIZES = [4, 8];

export const AI_NAMES = [
  "Sir Loin of Beef",
  "Baron von Bluffalo",
  "Duchess Doomscroll",
  "Count Cardigan",
  "Earl of Awkward",
  "Viscount Vibecheck",
  "Marquess of Mischief",
];

// 8 hues spread around the color wheel (not the closest-named Tailwind swatch to each
// other) so every seat stays visually distinct even at a glance -- Red/Orange used to
// sit right next to each other in hue and were hard to tell apart; Emerald/Amber/Violet
// replace Orange/(the old Purple slot)/(kept Purple's neighbor) to widen the gaps. Blue
// stays first on purpose: seat 0 is always "you" in solo play, so its color is the one
// most worth keeping stable across any future palette tweak.
export const PLAYER_COLOR_CLASSES = [
  "border-blue-500 bg-blue-50 dark:bg-blue-950",
  "border-red-500 bg-red-50 dark:bg-red-950",
  "border-emerald-500 bg-emerald-50 dark:bg-emerald-950",
  "border-amber-500 bg-amber-50 dark:bg-amber-950",
  "border-violet-500 bg-violet-50 dark:bg-violet-950",
  "border-pink-500 bg-pink-50 dark:bg-pink-950",
  "border-lime-500 bg-lime-50 dark:bg-lime-950",
  "border-cyan-500 bg-cyan-50 dark:bg-cyan-950",
];

// Same order/palette as PLAYER_COLOR_CLASSES, as plain text colors for the end screen.
export const PLAYER_TEXT_COLOR_CLASSES = [
  "text-blue-600 dark:text-blue-400",
  "text-red-600 dark:text-red-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-amber-600 dark:text-amber-400",
  "text-violet-600 dark:text-violet-400",
  "text-pink-600 dark:text-pink-400",
  "text-lime-600 dark:text-lime-400",
  "text-cyan-600 dark:text-cyan-400",
];

// Same order again, as a left-border accent color for the end screen's per-player tables.
export const PLAYER_BORDER_COLOR_CLASSES = [
  "border-blue-500",
  "border-red-500",
  "border-emerald-500",
  "border-amber-500",
  "border-violet-500",
  "border-pink-500",
  "border-lime-500",
  "border-cyan-500",
];

// Same order again, as a solid dot color -- for compact legend/indicator swatches (e.g. CardCatalog's "My Cards" key) too small for a border+fill treatment.
export const PLAYER_DOT_COLOR_CLASSES = [
  "bg-blue-500",
  "bg-red-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
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
