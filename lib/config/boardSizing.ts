import { BoardBounds } from "@/lib/engine/types";

/** True middle index of a 0-indexed axis of length `size`. Rounds down when `size` is even (no single center cell). */
function centerIndex(size: number): number {
  return Math.floor((size - 1) / 2);
}

/** Builds a BoardBounds with `center` always derived from `width`/`height` -- never entered by hand, so it can't drift out of sync. */
function makeBoardBounds(width: number, height: number): BoardBounds {
  return { width, height, center: { x: centerIndex(width), y: centerIndex(height) } };
}

/**
 * Board dimensions by player count, per game_spec.md's table (2-5p) extended to 6-8p.
 * Not in the spec — flagged there as "a later extension" — so the 6p+ entries are
 * extrapolations, not locked numbers. Only width/height are configured here; each
 * board's center tile is always the true middle (see makeBoardBounds), so there's
 * nothing here that can be out of sync with the dimensions.
 */
const BOARD_SIZE_BY_PLAYER_COUNT: Record<number, { width: number; height: number }> = {
  2: { width: 5, height: 5 },
  3: { width: 7, height: 5 },
  4: { width: 7, height: 7 },
  5: { width: 9, height: 7 },
  6: { width: 9, height: 9 },
  7: { width: 11, height: 9 },
  8: { width: 11, height: 11 },
};

export const BOARD_BOUNDS_BY_PLAYER_COUNT: Record<number, BoardBounds> = Object.fromEntries(
  Object.entries(BOARD_SIZE_BY_PLAYER_COUNT).map(([playerCount, { width, height }]) => [
    Number(playerCount),
    makeBoardBounds(width, height),
  ])
);
