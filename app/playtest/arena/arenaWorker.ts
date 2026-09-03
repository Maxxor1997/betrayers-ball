import { DEFAULT_TWO_PLY_OPTIONS } from "@/lib/ai/twoPly";
import { randomCenterEffectPool } from "@/lib/content/centerEffects";
import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";
import { ArenaSeatBuckets, ArenaSeatConfig, ArenaStats, simulateArenaGame, simulateFixedSeatArenaGame } from "@/lib/playtest/aiArena";

/**
 * Runs the actual batch loop off the main thread. page.tsx used to run this same loop
 * inline, yielding every YIELD_INTERVAL_MS via `await new Promise(r => setTimeout(r,
 * 0))` so the tab stayed paintable/cancelable during a big run -- but that's exactly
 * the kind of timer browsers throttle hard the moment a tab is backgrounded (on this
 * app's own domain or Vercel alike -- it was never a hosting issue, the whole
 * simulation is client-side; see aiArena.ts).
 *
 * Moving the loop into a worker does NOT actually fix that part -- tested and
 * confirmed still stalling after several minutes backgrounded, on both the old
 * single-loop version and this one. Chrome's "Intensive Wake Up Throttling" (kicks in
 * hardest after ~5 minutes backgrounded) throttles a page's dedicated workers along
 * with its main thread, not just the main thread, contradicting an earlier (wrong)
 * assumption here that workers were exempt. The only way to genuinely survive a
 * backgrounded tab for an extended stretch is running the batch server-side, decoupled
 * from any browser tab's lifecycle entirely -- not implemented (bigger change: a new
 * API route, chunked execution around Vercel's function time limits, polling instead
 * of postMessage for progress).
 *
 * What a worker DOES still buy: real parallelism. Every simulated game is independent,
 * so splitting a batch across several of these (see page.tsx's runBatch, one per
 * navigator.hardwareConcurrency) gives a genuine speedup while the tab is open/
 * focused, or backgrounded only briefly -- that part holds regardless of the
 * long-backgrounded-tab throttling issue above.
 */
const YIELD_INTERVAL_MS = 50;

export interface ArenaWorkerStartPayload {
  mode: "shuffle" | "fixed";
  playerCount: number;
  centerEffect: CenterEffectId | "random";
  selectedDifficulties: AiDifficulty[];
  gameCount: number;
  hardBudgetMs: number;
  fixedSeatConfigs: ArenaSeatConfig[];
  /** The batch's starting point, not a fresh empty one -- a "Run" click keeps
   * appending to whatever's already accumulated (see page.tsx's own persisted-stats
   * doc comment), so the worker has to pick up from here, not from zero. */
  initialStats: ArenaStats;
  initialSeatBuckets: ArenaSeatBuckets;
}

export type ArenaWorkerRequest = { type: "start"; payload: ArenaWorkerStartPayload } | { type: "cancel" };

export type ArenaWorkerResponse =
  | { type: "progress"; completed: number; stats?: ArenaStats; seatBuckets?: ArenaSeatBuckets }
  | { type: "done"; completed: number; stats: ArenaStats; seatBuckets: ArenaSeatBuckets; cancelled: boolean };

// This project's tsconfig uses the "dom" lib project-wide (not "webworker" -- the two
// conflict if both are listed, since they define incompatible globals for things like
// `self`), so ambient `self` here would otherwise type as `Window`, whose
// `postMessage` requires a targetOrigin argument a real worker's doesn't. Declaring it
// locally as `Worker` instead -- the same postMessage/onmessage shape a worker's own
// global scope actually has, just borrowed from the "other side" of the same
// interface -- gets the right signatures without needing a second, worker-only
// tsconfig.
declare const self: Worker;

let cancelled = false;

self.onmessage = (e: MessageEvent<ArenaWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  cancelled = false;
  runBatch(msg.payload);
};

async function runBatch(payload: ArenaWorkerStartPayload): Promise<void> {
  const { mode, playerCount, centerEffect, selectedDifficulties, gameCount, hardBudgetMs, fixedSeatConfigs, initialStats, initialSeatBuckets } = payload;

  // Mutated in place across the whole run, same working-copy pattern the main-thread
  // version used -- postMessage's own structured-clone deep-copies whatever's posted
  // below regardless, so there's no need to spread these before sending (unlike the
  // old React-state version, where a shallow spread's only job was giving setState a
  // new top-level reference to actually notice -- postMessage always hands the main
  // thread a brand-new object graph on its own).
  const workingStats = initialStats;
  const workingSeatBuckets = initialSeatBuckets;
  const randomPool = centerEffect === "random" ? randomCenterEffectPool(playerCount) : null;
  const hardOptions = { ...DEFAULT_TWO_PLY_OPTIONS, timeBudgetMs: hardBudgetMs };
  let completed = 0;
  let lastYieldAt = performance.now();

  for (let i = 0; i < gameCount; i++) {
    const effect = centerEffect === "random" ? randomPool![Math.floor(Math.random() * randomPool!.length)] : centerEffect;
    if (mode === "shuffle") {
      simulateArenaGame(playerCount, effect, selectedDifficulties, workingStats, Math.random, hardOptions);
    } else {
      simulateFixedSeatArenaGame(effect, fixedSeatConfigs, workingSeatBuckets, Math.random);
    }
    completed++;

    if (completed === gameCount || performance.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
      self.postMessage(
        mode === "shuffle" ? { type: "progress", completed, stats: workingStats } : { type: "progress", completed, seatBuckets: workingSeatBuckets }
      );
      if (cancelled) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYieldAt = performance.now();
    }
  }

  self.postMessage({ type: "done", completed, stats: workingStats, seatBuckets: workingSeatBuckets, cancelled } satisfies ArenaWorkerResponse);
}
