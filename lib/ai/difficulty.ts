import { AiDifficulty, GameAction, GameState } from "../engine/types";
import { chooseGreedyAiAction } from "./greedyAi";
import { chooseMctsAction, DEFAULT_MCTS_OPTIONS, MctsOptions } from "./mcts";
import { chooseRandomAiAction } from "./randomAi";

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
 * specific strategy module (randomAi.ts/greedyAi.ts/mcts.ts) directly -- keeps "which
 * difficulty maps to which strategy" in exactly one place. "hard" runs a determinized,
 * depth-capped Monte Carlo tree search (see mcts.ts) at its default time budget --
 * unlike easy/medium, its per-decision cost is a tunable wall-clock budget, not a
 * roughly-fixed small computation, so it's meaningfully slower per turn (by design --
 * see DEFAULT_MCTS_OPTIONS's doc comment). That's still fine for real single-player/
 * multiplayer games (it hides inside the existing AI_TURN_DELAY_MS pacing beat), but
 * worth knowing before selecting "hard" for a large AI Arena batch: hundreds of games
 * each with dozens of hard-difficulty turns adds up fast. `mctsOptions` is an escape
 * hatch for exactly that case (and for fast-running tests) -- every real call site
 * just omits it and gets DEFAULT_MCTS_OPTIONS; it's ignored for every other difficulty.
 */
export function chooseAiActionForDifficulty(
  state: GameState,
  playerId: string,
  difficulty: AiDifficulty,
  rng: Rng = Math.random,
  mctsOptions: MctsOptions = DEFAULT_MCTS_OPTIONS
): GameAction {
  if (difficulty === "easy") return chooseRandomAiAction(state, playerId, rng);
  if (difficulty === "hard") return chooseMctsAction(state, playerId, mctsOptions, rng);
  return chooseGreedyAiAction(state, playerId, rng);
}
