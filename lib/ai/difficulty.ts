import { AiDifficulty, GameAction, GameState } from "../engine/types";
import { chooseGreedyAiAction } from "./greedyAi";
import { chooseRandomAiAction } from "./randomAi";
import { chooseTwoPlyAction, DEFAULT_TWO_PLY_OPTIONS, TwoPlyOptions } from "./twoPly";

export type Rng = () => number;

/** Every selectable difficulty, in the order a UI should list them. */
export const AI_DIFFICULTIES: AiDifficulty[] = ["easy", "medium", "hard"];

export const AI_DIFFICULTY_LABELS: Record<AiDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export const DEFAULT_AI_DIFFICULTY: AiDifficulty = "medium";

/**
 * Single entrypoint every AI-turn call site should go through instead of importing a
 * specific strategy module (randomAi.ts/greedyAi.ts/twoPly.ts) directly -- keeps
 * "which difficulty maps to which strategy" in exactly one place. "hard" adds a real
 * extra ply on top of Medium's placement evaluation (see twoPly.ts) at its default
 * time budget -- unlike easy/medium, its per-decision cost is a tunable wall-clock
 * budget, not a roughly-fixed small computation, so it's meaningfully slower per turn
 * (by design -- see DEFAULT_TWO_PLY_OPTIONS' doc comment). That's still fine for real
 * single-player/multiplayer games (it hides inside the existing AI_TURN_DELAY_MS
 * pacing beat), but worth knowing before selecting "hard" for a large AI Arena batch:
 * hundreds of games each with dozens of hard-difficulty turns adds up fast.
 * `hardOptions` is an escape hatch for exactly that case (and for fast-running tests)
 * -- every real call site just omits it and gets DEFAULT_TWO_PLY_OPTIONS; it's ignored
 * for every other difficulty.
 */
export function chooseAiActionForDifficulty(
  state: GameState,
  playerId: string,
  difficulty: AiDifficulty,
  rng: Rng = Math.random,
  hardOptions: TwoPlyOptions = DEFAULT_TWO_PLY_OPTIONS
): GameAction {
  if (difficulty === "easy") return chooseRandomAiAction(state, playerId, rng);
  if (difficulty === "hard") return chooseTwoPlyAction(state, playerId, hardOptions, rng);
  return chooseGreedyAiAction(state, playerId, rng);
}
