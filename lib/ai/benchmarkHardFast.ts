/**
 * Standalone timing benchmark for chooseHardFastAction -- not a vitest test (no
 * assertions, deliberately slow/wall-clock-timing-dependent), run directly via
 * `npx tsx lib/ai/benchmarkHardFast.ts`. Plays out several full games, letting one
 * seat's every placement decision go through chooseHardFastAction (every other seat
 * uses plain Medium) so the timing breakdown reflects a realistic mix of board states
 * across a whole game (sparse early boards, dense late boards), not one artificial
 * snapshot. Reports where benchmarkTimings' wall-clock buckets (see hardFast.ts) went,
 * both in aggregate and per decision/sample.
 */
import { configForPlayerCount, createGame } from "@/lib/engine/game";
import { applyAction } from "@/lib/engine/game";
import { currentPlayerId } from "@/lib/engine/turns";
import { chooseGreedyAiAction } from "@/lib/ai/greedyAi";
import { benchmarkTimings, chooseHardFastAction, DEFAULT_HARD_FAST_OPTIONS, resetBenchmarkTimings } from "@/lib/ai/hardFast";
import { CenterEffectId } from "@/lib/engine/types";

const PLAYER_COUNT = 4;
const CENTER_EFFECT: CenterEffectId = "none";
const GAMES_TO_PLAY = 8;
/** Only this seat's placement decisions run through chooseHardFastAction -- every other seat is plain Medium, same as a real mixed-difficulty room. */
const HARD_SEAT_INDEX = 0;

/**
 * Deterministic sample count (maxPasses), not the real wall-clock budget --
 * DEFAULT_HARD_FAST_OPTIONS' real 250ms deadline makes chooseHardFastAction's own
 * round-robin loop sensitive to how much wall-clock the instrumentation itself
 * consumes (more/finer timer calls -> less budget left for real samples -> a
 * different number of samples run -> different rng consumption -> a different game
 * trajectory than an unInstrumented run would have taken). Fixing maxPasses instead
 * makes the sample count -- and so the whole benchmark -- reproducible and comparable
 * run to run, independent of instrumentation overhead. timeBudgetMs is set generously
 * high so it never actually binds.
 */
const BENCHMARK_OPTIONS = { ...DEFAULT_HARD_FAST_OPTIONS, timeBudgetMs: 60_000, maxPasses: 20 };

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function playOneGame(rng: () => number): void {
  const playerIds = Array.from({ length: PLAYER_COUNT }, (_, i) => `p${i}`);
  const config = configForPlayerCount(PLAYER_COUNT, CENTER_EFFECT, "medium");
  let state = createGame(playerIds, config, rng, playerIds, 0);
  const hardSeatId = playerIds[HARD_SEAT_INDEX];

  let steps = 0;
  const maxSteps = 2000; // generous safety cap, same spirit as evaluateCandidateOnce's own
  while (state.phase !== "ended" && steps < maxSteps) {
    if (state.phase === "voting") {
      for (const p of state.players) {
        if (!(p.id in state.votes)) {
          state = applyAction(state, chooseGreedyAiAction(state, p.id, rng), rng);
        }
      }
      steps++;
      continue;
    }
    const activeId = currentPlayerId(state);
    const action = activeId === hardSeatId ? chooseHardFastAction(state, activeId, BENCHMARK_OPTIONS, rng) : chooseGreedyAiAction(state, activeId, rng);
    state = applyAction(state, action, rng);
    steps++;
  }
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function main(): void {
  resetBenchmarkTimings();
  const rng = deterministicRng(42);
  const wallStart = performance.now();
  for (let i = 0; i < GAMES_TO_PLAY; i++) playOneGame(rng);
  const wallTotal = performance.now() - wallStart;

  const t = benchmarkTimings;
  const measuredTotal = t.rankCandidatesMs + t.determinizeMs + t.applyCandidateMs + t.simulateForwardMs + t.scoreResultMs;

  const buckets: { label: string; ms: number }[] = [
    { label: "rankCandidates (initial Medium-style shortlist, once/decision)", ms: t.rankCandidatesMs },
    { label: "determinize (hidden-info guess, once/sample)", ms: t.determinizeMs },
    { label: "applyCandidate (place candidate + resolve any vote)", ms: t.applyCandidateMs },
    { label: "simulateForward (roundsAhead lookahead loop -- chooseGreedyAiAction x N)", ms: t.simulateForwardMs },
    { label: "scoreResult (trueValues/computeGameResult)", ms: t.scoreResultMs },
  ];

  console.log(`\n=== chooseHardFastAction timing benchmark (${GAMES_TO_PLAY} games, ${PLAYER_COUNT}p, seat ${HARD_SEAT_INDEX} = Hard) ===\n`);
  console.log(`Decisions: ${t.decisions}, Samples: ${t.samples} (${(t.samples / Math.max(1, t.decisions)).toFixed(1)} samples/decision)`);
  console.log(`Wall time: ${formatMs(wallTotal)} total, ${formatMs(wallTotal / Math.max(1, t.decisions))}/decision`);
  console.log(`Measured (instrumented) time: ${formatMs(measuredTotal)} total, ${formatMs(measuredTotal / Math.max(1, t.decisions))}/decision\n`);

  for (const b of buckets) {
    const pct = measuredTotal === 0 ? 0 : (b.ms / measuredTotal) * 100;
    const perSample = t.samples === 0 ? 0 : b.ms / t.samples;
    console.log(`${b.label}\n  ${formatMs(b.ms)} total (${pct.toFixed(1)}%), ${formatMs(perSample)}/sample`);
  }

  console.log(`\n--- simulateForward sub-breakdown (${t.simulatedTurns} simulated turns total) ---`);
  const chosePct = t.simulateForwardMs === 0 ? 0 : (t.simulateChooseMs / t.simulateForwardMs) * 100;
  const applyPct = t.simulateForwardMs === 0 ? 0 : (t.simulateApplyMs / t.simulateForwardMs) * 100;
  console.log(
    `chooseGreedyAiAction (AI deciding a simulated turn)\n  ${formatMs(t.simulateChooseMs)} (${chosePct.toFixed(1)}% of simulateForward), ${formatMs(t.simulateChooseMs / Math.max(1, t.simulatedTurns))}/turn`
  );
  console.log(
    `applyAction + resolvePendingVotes (applying that turn)\n  ${formatMs(t.simulateApplyMs)} (${applyPct.toFixed(1)}% of simulateForward), ${formatMs(t.simulateApplyMs / Math.max(1, t.simulatedTurns))}/turn`
  );
  console.log(`Simulated turns per sample: ${(t.simulatedTurns / Math.max(1, t.samples)).toFixed(2)}`);

  // Machine-readable dump, for feeding into a visualization.
  console.log("\n--- JSON ---");
  console.log(
    JSON.stringify(
      {
        gamesPlayed: GAMES_TO_PLAY,
        playerCount: PLAYER_COUNT,
        decisions: t.decisions,
        samples: t.samples,
        wallTotalMs: wallTotal,
        measuredTotalMs: measuredTotal,
        buckets: buckets.map((b) => ({ label: b.label, ms: b.ms })),
      },
      null,
      2
    )
  );
}

main();
