import { computeAiVote } from "../engine/endgame";
import { AiDifficulty, GameAction, GameState } from "../engine/types";
import { chooseGreedyAiAction } from "./greedyAi";
import { chooseExpertVote, chooseHardFastAction, DEFAULT_HARD_FAST_OPTIONS } from "./hardFast";
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

export const DEFAULT_AI_DIFFICULTY: AiDifficulty = "expert";

/**
 * Pacing beat between AI turns for real play with a visible board (single-player
 * app/play/page.tsx, multiplayer lib/server/session.ts) -- long enough for the
 * board's live tints/animations to finish before the next move lands. Bulk/headless
 * paths (lib/playtest/aiArena.ts's simulation loops) skip this entirely by calling
 * applyAction in a tight loop with no timer at all; app/playtest/PlaySelf.tsx still
 * paces itself for a visible board but wants the fastest possible beat since it's a
 * playtest/tuning tool, not real play, so it uses AI_TURN_DELAY_FAST_MS instead.
 */
export const AI_TURN_DELAY_MS = 750;

/** See AI_TURN_DELAY_MS -- same role, but for playtest/tuning views that still render
 * a board (so need a nonzero setTimeout to let React commit between turns) but have no
 * reason to wait for animations. */
export const AI_TURN_DELAY_FAST_MS = 0;

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
 * fast-running tests) -- it overrides whichever of the two is selected; every real
 * call site just omits it and each difficulty gets its own real default. Ignored for
 * easy/medium. Only covers the shape "hard" and "expert" share (timeBudgetMs/
 * maxCandidates/roundsAhead/maxPasses) -- "expert"'s separate flip-search budget
 * (flipMaxCandidates/flipTimeBudgetMs/flipMaxPasses, see HardFastOptions) always stays
 * at DEFAULT_HARD_FAST_OPTIONS' own values, even when `hardOptions` overrides the rest,
 * since no real call site has needed to tune that independently yet.
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
  if (difficulty === "expert") return chooseHardFastAction(state, playerId, hardOptions ? { ...DEFAULT_HARD_FAST_OPTIONS, ...hardOptions } : DEFAULT_HARD_FAST_OPTIONS, rng);
  return chooseGreedyAiAction(state, playerId, rng);
}

/**
 * The vote-decision counterpart to chooseAiActionForDifficulty -- see
 * game.ts's ComputeVoteFn for the injection seam this plugs into (advanceTurn's
 * round-boundary auto-fill of every AI seat's vote, which has no difficulty awareness
 * built into the engine itself). Every difficulty except "expert" keeps the exact same
 * computeAiVote heuristic voting has always used; "expert" alone gets chooseExpertVote's
 * real simulated comparison (see hardFast.ts). `hardOptions` overrides expert's vote
 * search budget the same way it overrides chooseAiActionForDifficulty's -- an escape
 * hatch for large AI Arena batches and fast tests, ignored for every other difficulty.
 */
export function computeVoteForDifficulty(state: GameState, playerId: string, difficulty: AiDifficulty, rng: Rng = Math.random, hardOptions?: TwoPlyOptions): boolean {
  if (difficulty === "expert") return chooseExpertVote(state, playerId, hardOptions ? { ...DEFAULT_HARD_FAST_OPTIONS, ...hardOptions } : DEFAULT_HARD_FAST_OPTIONS, rng);
  return computeAiVote(state, playerId, rng);
}
