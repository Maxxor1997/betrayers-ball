import { AiDifficulty, GameAction, GameState } from "../engine/types";
import { chooseGreedyAiAction } from "./greedyAi";
import { chooseHardFastAction, DEFAULT_HARD_FAST_OPTIONS } from "./hardFast";
import { chooseRandomAiAction } from "./randomAi";
import { chooseTwoPlyAction, DEFAULT_TWO_PLY_OPTIONS, TwoPlyOptions } from "./twoPly";

export type Rng = () => number;

/** Every selectable difficulty, in the order a UI should list them. */
export const AI_DIFFICULTIES: AiDifficulty[] = ["easy", "medium", "hard", "expert"];

export const AI_DIFFICULTY_LABELS: Record<AiDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  expert: "Expert",
};

export const DEFAULT_AI_DIFFICULTY: AiDifficulty = "medium";

/**
 * Single entrypoint every AI-turn call site should go through instead of importing a
 * specific strategy module (randomAi.ts/greedyAi.ts/twoPly.ts/hardFast.ts) directly --
 * keeps "which difficulty maps to which strategy" in exactly one place. "hard" and
 * "expert" both add a real extra ply on top of Medium's placement evaluation (see
 * twoPly.ts/hardFast.ts) at their own default time budget -- unlike easy/medium,
 * their per-decision cost is a tunable wall-clock budget, not a roughly-fixed small
 * computation, so both are meaningfully slower per turn (by design -- see
 * DEFAULT_TWO_PLY_OPTIONS'/DEFAULT_HARD_FAST_OPTIONS' own doc comments). That's still
 * fine for real single-player/multiplayer games (it hides inside the existing
 * AI_TURN_DELAY_MS pacing beat), but worth knowing before selecting either for a large
 * AI Arena batch: hundreds of games each with dozens of hard/expert-difficulty turns
 * adds up fast. `hardOptions` is an escape hatch for exactly that case (and for
 * fast-running tests) -- it overrides whichever of the two is selected (they share the
 * same options shape); every real call site just omits it and each difficulty gets its
 * own real default. Ignored for easy/medium.
 */
export function chooseAiActionForDifficulty(
  state: GameState,
  playerId: string,
  difficulty: AiDifficulty,
  rng: Rng = Math.random,
  hardOptions?: TwoPlyOptions
): GameAction {
  if (difficulty === "easy") return chooseRandomAiAction(state, playerId, rng);
  if (difficulty === "hard") return chooseTwoPlyAction(state, playerId, hardOptions ?? DEFAULT_TWO_PLY_OPTIONS, rng);
  if (difficulty === "expert") return chooseHardFastAction(state, playerId, hardOptions ?? DEFAULT_HARD_FAST_OPTIONS, rng);
  return chooseGreedyAiAction(state, playerId, rng);
}
