import { BoardBounds } from "@/lib/engine/types";

/**
 * Board sizing by player count, per game_spec.md's table (2-5p) extended to 6-8p using
 * the same pattern: height held at 5, width odd, usable cells (W*H-1) grows by 10 per
 * player (14, 24, 34, 44, 54, 64, 74...). Not in the spec — flagged there as "a later
 * extension" — so the 6p+ entries are extrapolations, not locked numbers.
 */
export const BOARD_BOUNDS_BY_PLAYER_COUNT: Record<number, BoardBounds> = {
  2: { width: 5, height: 3, center: { x: 2, y: 1 } },
  3: { width: 5, height: 5, center: { x: 2, y: 2 } },
  4: { width: 7, height: 5, center: { x: 3, y: 2 } },
  5: { width: 9, height: 5, center: { x: 4, y: 2 } },
  6: { width: 11, height: 5, center: { x: 5, y: 2 } },
  7: { width: 13, height: 5, center: { x: 6, y: 2 } },
  8: { width: 15, height: 5, center: { x: 7, y: 2 } },
};
