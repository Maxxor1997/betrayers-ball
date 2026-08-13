"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { AI_DIFFICULTIES, AI_DIFFICULTY_LABELS } from "@/lib/ai/difficulty";
import { DEFAULT_TWO_PLY_OPTIONS } from "@/lib/ai/twoPly";
import { CENTER_EFFECTS, randomCenterEffectPool, selectableCenterEffects } from "@/lib/content/centerEffects";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";
import { ArenaBucketRow, ArenaStats, createEmptyArenaStats, simulateArenaGame, summarizeArenaStats } from "@/lib/playtest/aiArena";

/**
 * Hidden diagnostic tool -- deliberately not linked from anywhere (not home, not
 * /playtest itself), only reachable by typing this URL. Answers two questions the main
 * playtest page can't: does a higher AI difficulty actually win more, and does turn
 * order (who goes first) bias outcomes on its own? Every real entrypoint in the app
 * (home, /play, multiplayer, the main playtest simulator) deliberately stays one
 * difficulty per whole game -- this page is the one place that puts different
 * difficulties in the same game, purely to measure them against each other.
 *
 * Ephemeral by design: no localStorage persistence (unlike the main playtest page's
 * running stats table), no "watch live" board, no per-card breakdown -- just two
 * result tables, reset on reload. A one-off diagnostic, not a tracked dataset.
 */
const ALL_PLAYER_COUNTS = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i);

/** Same cadence the main playtest page's runSimulation uses -- long enough to batch real throughput, short enough that the tab stays responsive/paintable during a large run. */
const YIELD_INTERVAL_MS = 50;

/**
 * Deliberately well above DEFAULT_TWO_PLY_OPTIONS.timeBudgetMs (the real-game default) --
 * unlike the lower bound (which only exists to run big batches faster), the upper
 * bound isn't capped at what a real game uses, since testing whether extra search
 * budget beyond that actually buys a bigger edge over Medium is exactly the kind of
 * question this diagnostic page exists for.
 */
const ARENA_HARD_BUDGET_MAX_MS = 3000;

function fmt(n: number | null, decimals = 2): string {
  return n === null ? "—" : n.toFixed(decimals);
}

function fmtPercent(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

function ResultsTable({ title, rows, firstColumnLabel }: { title: string; rows: ArenaBucketRow[]; firstColumnLabel: string }) {
  return (
    <div className="flex w-full flex-1 flex-col gap-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <p className="text-sm font-medium">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">Run a batch to see results.</p>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                <th className="px-3 py-2">{firstColumnLabel}</th>
                <th className="px-3 py-2 text-right">Games</th>
                <th className="px-3 py-2 text-right">Win rate</th>
                <th className="px-3 py-2 text-right" title="Average (rank - baseline) / (half the game's rank spread), on a fixed -1..+1 scale -- same normalized metric the main playtest page's Placement Δ uses.">
                  Placement Δ
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">{row.label}</td>
                  <td className="px-3 py-1.5 text-right">{row.gamesPlayed}</td>
                  <td className="px-3 py-1.5 text-right">{fmtPercent(row.winRate)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(row.avgPlacementDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ArenaPage() {
  const [playerCount, setPlayerCount] = useState(4);
  const [centerEffect, setCenterEffect] = useState<CenterEffectId | "random">("random");
  const [selectedDifficulties, setSelectedDifficulties] = useState<AiDifficulty[]>(["easy", "medium"]);
  const [gameCount, setGameCount] = useState(500);
  // Hard's real per-decision budget (DEFAULT_TWO_PLY_OPTIONS.timeBudgetMs, 250ms) is
  // calibrated for a single real game's pacing, not for running hundreds of games back
  // to back in a batch -- this lets a batch trade search strength for throughput while
  // testing, independent of the real default every actual game entrypoint still uses.
  const [hardBudgetMs, setHardBudgetMs] = useState(75);
  const [stats, setStats] = useState<ArenaStats>(createEmptyArenaStats());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);
  const runInProgressRef = useRef(false);

  function toggleDifficulty(d: AiDifficulty) {
    setSelectedDifficulties((prev) => {
      if (prev.includes(d)) {
        // Never allow the last one to be unchecked -- simulateArenaGame needs at
        // least one difficulty to assign, and a truly empty selection has nothing
        // meaningful to compare anyway.
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== d);
      }
      return [...prev, d];
    });
  }

  async function runBatch() {
    if (runInProgressRef.current || selectedDifficulties.length === 0) return;
    // The Games/budget number fields intentionally don't clamp until blur (see their
    // onBlur handlers) so they're editable mid-typing -- clicking Run without tabbing
    // away first could otherwise still be sitting on an unclamped (or blank/0) value.
    const clampedGameCount = Math.max(1, Math.min(50000, gameCount || 1));
    const clampedHardBudgetMs = Math.max(5, Math.min(ARENA_HARD_BUDGET_MAX_MS, hardBudgetMs || 5));
    setGameCount(clampedGameCount);
    setHardBudgetMs(clampedHardBudgetMs);

    runInProgressRef.current = true;
    setRunning(true);
    setProgress(0);
    cancelRef.current = false;
    // Yield once immediately so the "running" UI (disabled inputs, progress bar)
    // actually paints before the batch's first uninterrupted stretch of work --
    // same reasoning as the main playtest page's own runSimulation.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mutated in place across the whole run, same working-copy pattern
    // cardStats.ts's tallyGame uses -- committed to React state once per batch, not
    // once per game, so a large run doesn't trigger thousands of re-renders.
    const working = stats;
    const randomPool = centerEffect === "random" ? randomCenterEffectPool(playerCount) : null;
    const hardOptions = { ...DEFAULT_TWO_PLY_OPTIONS, timeBudgetMs: clampedHardBudgetMs };
    let completed = 0;
    let lastYieldAt = performance.now();

    for (let i = 0; i < clampedGameCount; i++) {
      const effect = centerEffect === "random" ? randomPool![Math.floor(Math.random() * randomPool!.length)] : centerEffect;
      simulateArenaGame(playerCount, effect, selectedDifficulties, working, Math.random, hardOptions);
      completed++;

      if (completed === gameCount || performance.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
        setProgress(completed);
        setStats({ ...working });
        if (cancelRef.current) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYieldAt = performance.now();
      }
    }

    setRunning(false);
    runInProgressRef.current = false;
  }

  function handleReset() {
    setStats(createEmptyArenaStats());
    setProgress(0);
  }

  const { byDifficulty, byPosition } = summarizeArenaStats(stats);

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-3xl flex-col gap-1">
        <h1 className="text-lg font-semibold">AI Arena</h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Pits the selected AI difficulties against each other in the same games (every other part of the app uses one difficulty per whole game --
          this page is the exception, purely to measure them against each other). Not linked from anywhere else.{" "}
          <Link href="/playtest" className="underline">
            Back to playtest
          </Link>
        </p>
      </header>

      <div className="flex w-full max-w-3xl flex-col gap-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
        <p className="text-sm font-medium">Configure a batch</p>
        <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 text-sm text-zinc-600 sm:grid-cols-[auto_1fr_auto_1fr] dark:text-zinc-400">
          <label htmlFor="arena-players">Players</label>
          <select
            id="arena-players"
            value={playerCount}
            disabled={running}
            onChange={(e) => setPlayerCount(Number(e.target.value))}
            className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          >
            {ALL_PLAYER_COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <label htmlFor="arena-center">Location</label>
          <select
            id="arena-center"
            value={centerEffect}
            disabled={running}
            onChange={(e) => setCenterEffect(e.target.value as CenterEffectId | "random")}
            className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          >
            <option value="random">Random</option>
            <option value="none">None</option>
            {selectableCenterEffects(playerCount).map((id) => (
              <option key={id} value={id}>
                {CENTER_EFFECTS[id].label}
              </option>
            ))}
          </select>
          <label htmlFor="arena-games">Games</label>
          <input
            id="arena-games"
            type="number"
            min={1}
            max={50000}
            value={gameCount}
            disabled={running}
            // Only the digits typed so far -- NOT clamped here, since clamping mid-edit
            // (e.g. snapping an emptied field straight back to the minimum) makes it
            // impossible to ever get past one digit while retyping a number. Clamped
            // once, on blur, instead.
            onChange={(e) => setGameCount(e.target.value === "" ? 0 : Number(e.target.value))}
            onBlur={() => setGameCount((v) => Math.max(1, Math.min(50000, v || 1)))}
            className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          />
        </div>

        <p className="mt-2 text-xs font-medium text-zinc-500 uppercase dark:text-zinc-400">Difficulties (each game, seats get a random shuffle of these)</p>
        <div className="flex flex-wrap gap-3 text-sm">
          {AI_DIFFICULTIES.map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input type="checkbox" checked={selectedDifficulties.includes(d)} disabled={running} onChange={() => toggleDifficulty(d)} className="disabled:opacity-50" />
              {AI_DIFFICULTY_LABELS[d]}
            </label>
          ))}
        </div>

        {selectedDifficulties.includes("hard") && (
          <div className="mt-2 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <label
              htmlFor="arena-hard-budget"
              title={`Real games use ${DEFAULT_TWO_PLY_OPTIONS.timeBudgetMs}ms. Lower this for faster/bigger batches while testing (strength drops with it); raise it above ${DEFAULT_TWO_PLY_OPTIONS.timeBudgetMs}ms to see whether more search budget than a real game gets actually buys a bigger edge over Medium.`}
            >
              Hard search budget (ms)
            </label>
            <input
              id="arena-hard-budget"
              type="number"
              min={5}
              max={ARENA_HARD_BUDGET_MAX_MS}
              value={hardBudgetMs}
              disabled={running}
              // Same "don't clamp mid-edit" reasoning as the Games field above.
              onChange={(e) => setHardBudgetMs(e.target.value === "" ? 0 : Number(e.target.value))}
              onBlur={() => setHardBudgetMs((v) => Math.max(5, Math.min(ARENA_HARD_BUDGET_MAX_MS, v || 5)))}
              className="w-20 min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
            />
            <span className="text-xs">(real games use {DEFAULT_TWO_PLY_OPTIONS.timeBudgetMs}ms)</span>
          </div>
        )}

        <div className="mt-2 flex items-center gap-2">
          {running ? (
            <>
              <div role="progressbar" aria-valuemin={0} aria-valuemax={gameCount} aria-valuenow={progress} className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${(progress / gameCount) * 100}%` }} />
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-zinc-500">
                {progress} / {gameCount}
              </span>
              <button
                onClick={() => (cancelRef.current = true)}
                className="shrink-0 rounded-full border border-zinc-300 px-3 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={runBatch} className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-sm whitespace-nowrap text-white dark:bg-zinc-100 dark:text-black">
                Run
              </button>
              <button
                onClick={handleReset}
                className="shrink-0 rounded-full border border-zinc-300 px-3 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex w-full max-w-3xl flex-col gap-4 sm:flex-row">
        <ResultsTable title="By difficulty" rows={byDifficulty} firstColumnLabel="Difficulty" />
        <ResultsTable title="By starting position" rows={byPosition} firstColumnLabel="Position" />
      </div>
    </div>
  );
}
