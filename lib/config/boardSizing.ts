import { BoardBounds } from "@/lib/engine/types";

/**
 * Board sizing by player count, per game_spec.md's table (2-5p) extended to 6p using
 * the same pattern: height held at 5, width odd, usable cells (W*H-1) grows by 10 per
 * player (14, 24, 34, 44, 54...). Not in the spec — flagged there as "a later
 * extension" — so this 6p entry is an extrapolation, not a locked number.
 */
export const BOARD_BOUNDS_BY_PLAYER_COUNT: Record<number, BoardBounds> = {
  2: { width: 5, height: 3, center: { x: 2, y: 1 } },
  3: { width: 5, height: 5, center: { x: 2, y: 2 } },
  4: { width: 7, height: 5, center: { x: 3, y: 2 } },
  5: { width: 9, height: 5, center: { x: 4, y: 2 } },
  6: { width: 11, height: 5, center: { x: 5, y: 2 } },
};
