"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AI_DIFFICULTIES, AI_DIFFICULTY_LABELS } from "@/lib/ai/difficulty";
import { DEFAULT_TWO_PLY_OPTIONS } from "@/lib/ai/twoPly";
import { CENTER_EFFECTS, randomCenterEffectPool, selectableCenterEffects } from "@/lib/content/centerEffects";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";
import {
  ArenaBucketRow,
  ArenaSeatBucketRow,
  ArenaSeatConfig,
  ArenaSeatBuckets,
  ArenaSeatStrategy,
  ARENA_SEAT_STRATEGY_LABELS,
  ArenaStats,
  arenaSeatConfigLabel,
  createEmptyArenaStats,
  createEmptyFixedSeatArenaStats,
  defaultArenaSeatConfig,
  simulateArenaGame,
  simulateFixedSeatArenaGame,
  summarizeArenaStats,
  summarizeFixedSeatArenaStats,
} from "@/lib/playtest/aiArena";
import { loadArenaState, resetArenaState, saveArenaState } from "@/lib/playtest/arenaStore";

/**
 * Hidden diagnostic tool -- deliberately not linked from anywhere (not home, not
 * /playtest itself), only reachable by typing this URL. Answers two questions the main
 * playtest page can't: does a higher AI difficulty actually win more, and does turn
 * order (who goes first) bias outcomes on its own? Every real entrypoint in the app
 * (home, /play, multiplayer, the main playtest simulator) deliberately stays one
 * difficulty per whole game -- this page is the one place that puts different
 * difficulties in the same game, purely to measure them against each other.
 *
 * Persists across reloads via arenaStore.ts (localStorage), same as the main playtest
 * page's own running stats table -- a batch here is a deliberate, often long-running
 * A/B comparison, so losing it to an accidental refresh defeats the point. Still no
 * "watch live" board or per-card breakdown though -- just the result tables.
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

type SortDir = "asc" | "desc";

/**
 * Generic click-to-sort header cell. `null` values (an untallied seat/bucket's
 * winRate/avgPlacementDelta) always sort to the bottom regardless of direction --
 * "no data yet" isn't meaningfully "low", so treating it as -Infinity/+Infinity
 * depending on direction would make it jump to whichever end is currently on top.
 */
function SortableHeader<K extends string>({
  label,
  sortKey,
  active,
  dir,
  align = "left",
  title,
  onSort,
}: {
  label: string;
  sortKey: K;
  active: boolean;
  dir: SortDir;
  align?: "left" | "right";
  title?: string;
  onSort: (key: K) => void;
}) {
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`} title={title}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        <span>{label}</span>
        <span className="w-3 text-zinc-400 dark:text-zinc-500">{active ? (dir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

function sortRows<T, K extends string>(rows: T[], sortKey: K | null, dir: SortDir, valueFor: (row: T, key: K) => string | number | null): T[] {
  if (!sortKey) return rows;
  const sorted = [...rows].sort((a, b) => {
    const av = valueFor(a, sortKey);
    const bv = valueFor(b, sortKey);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls always last
    if (bv === null) return -1;
    if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv));
    return av - bv;
  });
  if (dir === "desc") sorted.reverse();
  return sorted;
}

function useSort<K extends string>(defaultKey: K | null = null) {
  const [sortKey, setSortKey] = useState<K | null>(defaultKey);
  const [dir, setDir] = useState<SortDir>("desc");
  function onSort(key: K) {
    if (key === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDir("desc");
    }
  }
  return { sortKey, dir, onSort };
}

type ResultsSortKey = "label" | "gamesPlayed" | "winRate" | "avgPlacementDelta";

function ResultsTable({ title, rows, firstColumnLabel }: { title: string; rows: ArenaBucketRow[]; firstColumnLabel: string }) {
  const { sortKey, dir, onSort } = useSort<ResultsSortKey>();
  const sortedRows = sortRows(rows, sortKey, dir, (row, key) => row[key]);
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
                <SortableHeader label={firstColumnLabel} sortKey="label" active={sortKey === "label"} dir={dir} onSort={onSort} />
                <SortableHeader label="Games" sortKey="gamesPlayed" active={sortKey === "gamesPlayed"} dir={dir} align="right" onSort={onSort} />
                <SortableHeader label="Win rate" sortKey="winRate" active={sortKey === "winRate"} dir={dir} align="right" onSort={onSort} />
                <SortableHeader
                  label="Placement Δ"
                  sortKey="avgPlacementDelta"
                  active={sortKey === "avgPlacementDelta"}
                  dir={dir}
                  align="right"
                  title="Average (rank - baseline) / (half the game's rank spread), on a fixed -1..+1 scale -- same normalized metric the main playtest page's Placement Δ uses."
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
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

type SeatResultsSortKey = "label" | "config" | "gamesPlayed" | "winRate" | "avgPlacementDelta";

/** Same shape as ResultsTable, but with an extra "Config" column spelling out exactly what each seat ran with -- the whole point of the fixed-per-seat mode is comparing configurations, not just labels, so that has to be visible right next to the results, not just set-and-forgotten in the config form above. */
function SeatResultsTable({ rows }: { rows: ArenaSeatBucketRow[] }) {
  const { sortKey, dir, onSort } = useSort<SeatResultsSortKey>();
  const sortedRows = sortRows(rows, sortKey, dir, (row, key) => (key === "config" ? arenaSeatConfigLabel(row.config) : row[key]));
  return (
    <div className="flex w-full flex-1 flex-col gap-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <p className="text-sm font-medium">By seat</p>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">Run a batch to see results.</p>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                <SortableHeader label="Seat" sortKey="label" active={sortKey === "label"} dir={dir} onSort={onSort} />
                <SortableHeader label="Config" sortKey="config" active={sortKey === "config"} dir={dir} onSort={onSort} />
                <SortableHeader label="Games" sortKey="gamesPlayed" active={sortKey === "gamesPlayed"} dir={dir} align="right" onSort={onSort} />
                <SortableHeader label="Win rate" sortKey="winRate" active={sortKey === "winRate"} dir={dir} align="right" onSort={onSort} />
                <SortableHeader
                  label="Placement Δ"
                  sortKey="avgPlacementDelta"
                  active={sortKey === "avgPlacementDelta"}
                  dir={dir}
                  align="right"
                  title="Average (rank - baseline) / (half the game's rank spread), on a fixed -1..+1 scale -- same normalized metric the main playtest page's Placement Δ uses."
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr key={row.seatIndex} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">{row.label}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-zinc-600 dark:text-zinc-400">{arenaSeatConfigLabel(row.config)}</td>
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

/** One seat's row in the fixed-per-seat config form -- a strategy picker, plus the three search-budget fields only shown (and only meaningful) for the two "hard" strategies. */
function SeatConfigRow({
  seatIndex,
  config,
  disabled,
  onChange,
}: {
  seatIndex: number;
  config: ArenaSeatConfig;
  disabled: boolean;
  onChange: (config: ArenaSeatConfig) => void;
}) {
  const isHard = config.strategy === "hardTwoPly" || config.strategy === "hardFast";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
      <span className="w-14 shrink-0 font-medium text-zinc-800 dark:text-zinc-200">Seat {seatIndex + 1}</span>
      <select
        value={config.strategy}
        disabled={disabled}
        onChange={(e) => onChange({ ...config, strategy: e.target.value as ArenaSeatStrategy })}
        className="min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
      >
        {(Object.keys(ARENA_SEAT_STRATEGY_LABELS) as ArenaSeatStrategy[]).map((s) => (
          <option key={s} value={s}>
            {ARENA_SEAT_STRATEGY_LABELS[s]}
          </option>
        ))}
      </select>
      {isHard && (
        <>
          <label className="flex items-center gap-1">
            <span className="text-xs">ms</span>
            <input
              type="number"
              min={5}
              max={ARENA_HARD_BUDGET_MAX_MS}
              value={config.timeBudgetMs}
              disabled={disabled}
              onChange={(e) => onChange({ ...config, timeBudgetMs: e.target.value === "" ? 0 : Number(e.target.value) })}
              onBlur={() => onChange({ ...config, timeBudgetMs: Math.max(5, Math.min(ARENA_HARD_BUDGET_MAX_MS, config.timeBudgetMs || 5)) })}
              className="w-16 min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-xs">candidates</span>
            <input
              type="number"
              min={1}
              max={40}
              value={config.maxCandidates}
              disabled={disabled}
              onChange={(e) => onChange({ ...config, maxCandidates: e.target.value === "" ? 0 : Number(e.target.value) })}
              onBlur={() => onChange({ ...config, maxCandidates: Math.max(1, Math.min(40, config.maxCandidates || 1)) })}
              className="w-14 min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-xs">rounds ahead</span>
            <input
              type="number"
              min={1}
              max={5}
              value={config.roundsAhead}
              disabled={disabled}
              onChange={(e) => onChange({ ...config, roundsAhead: e.target.value === "" ? 0 : Number(e.target.value) })}
              onBlur={() => onChange({ ...config, roundsAhead: Math.max(1, Math.min(5, config.roundsAhead || 1)) })}
              className="w-12 min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
            />
          </label>
        </>
      )}
    </div>
  );
}

/** Which of the two independent testing modes this page is running -- see aiArena.ts's own doc comment on simulateFixedSeatArenaGame for what actually differs between them. */
type ArenaMode = "shuffle" | "fixed";

/**
 * Reads localStorage synchronously (no window access during SSR), so this can't run
 * until after mount -- same mount-gate pattern /playtest, /play, and /join use for
 * their own client-only state. Without this gate, seeding state straight from
 * localStorage in Arena's own useState initializers would make the server (always
 * sees no window, always defaults) and a client with a persisted non-default `mode`
 * (which picks between two entirely different JSX subtrees, not just different
 * numbers inside an otherwise-fixed shape) render genuinely different markup on first
 * paint -- exactly what React's hydration diffing flags as an error. Gating the whole
 * real component behind `mounted` instead means Arena only ever mounts fresh on the
 * client, where its initializers reading localStorage are always safe.
 */
export default function ArenaPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">Loading…</div>;
  }
  return <Arena />;
}

function Arena() {
  const [initial] = useState(() => loadArenaState());
  const [mode, setMode] = useState<ArenaMode>(initial.mode);
  const [playerCount, setPlayerCount] = useState(initial.playerCount);
  const [centerEffect, setCenterEffect] = useState<CenterEffectId | "random">(initial.centerEffect);
  const [selectedDifficulties, setSelectedDifficulties] = useState<AiDifficulty[]>(initial.selectedDifficulties);
  const [gameCount, setGameCount] = useState(initial.gameCount);
  // Hard's real per-decision budget (DEFAULT_TWO_PLY_OPTIONS.timeBudgetMs, 250ms) is
  // calibrated for a single real game's pacing, not for running hundreds of games back
  // to back in a batch -- this lets a batch trade search strength for throughput while
  // testing, independent of the real default every actual game entrypoint still uses.
  const [hardBudgetMs, setHardBudgetMs] = useState(initial.hardBudgetMs);
  const [stats, setStats] = useState<ArenaStats>(initial.stats);
  // Fixed-per-seat mode's own config + results -- kept sized to playerCount (see
  // resizeSeatConfigs) rather than derived fresh each render, so a seat's own edits
  // (strategy, budget, ...) survive a re-render and only get reset by an actual
  // playerCount change or an explicit Reset click.
  const [seatConfigs, setSeatConfigs] = useState<ArenaSeatConfig[]>(initial.seatConfigs);
  const [seatBuckets, setSeatBuckets] = useState<ArenaSeatBuckets>(initial.seatBuckets);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);
  const runInProgressRef = useRef(false);

  // Persists the whole batch -- results and the config that produced them -- on every
  // change, including the periodic mid-run commits below, so a refresh (accidental or
  // otherwise) never loses a batch in progress. Cheap: this page's whole state is a
  // handful of small buckets, not per-card-per-game granularity.
  useEffect(() => {
    saveArenaState({ mode, playerCount, centerEffect, selectedDifficulties, gameCount, hardBudgetMs, stats, seatConfigs, seatBuckets });
  }, [mode, playerCount, centerEffect, selectedDifficulties, gameCount, hardBudgetMs, stats, seatConfigs, seatBuckets]);

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

  /** Keeps seatConfigs/seatBuckets in sync whenever the player count changes -- existing seats' own edits survive, new seats default fresh, extra ones are dropped. Results reset along with it, same as changing player count already implicitly invalidates the shuffle mode's own running stats. */
  function handlePlayerCountChange(next: number) {
    setPlayerCount(next);
    setSeatConfigs((prev) => Array.from({ length: next }, (_, i) => prev[i] ?? defaultArenaSeatConfig()));
    setSeatBuckets(createEmptyFixedSeatArenaStats(next));
  }

  /** seatConfigs (React state) is the only place a seat's config lives -- see ArenaSeatBuckets' own doc comment in aiArena.ts for why an earlier version that also cached it inside the buckets array was a real staleness bug. */
  function updateSeatConfig(seatIndex: number, config: ArenaSeatConfig) {
    setSeatConfigs((prev) => prev.map((c, i) => (i === seatIndex ? config : c)));
  }

  async function runBatch() {
    if (runInProgressRef.current) return;
    if (mode === "shuffle" && selectedDifficulties.length === 0) return;
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
    const workingStats = stats;
    const workingSeatBuckets = seatBuckets;
    // Captured once, for this whole batch -- exactly the "fixed for the batch"
    // semantics this mode promises. Editing a seat mid-run isn't possible anyway (the
    // form's disabled while running), so this is never stale, just deliberately
    // pinned to whatever was configured at the moment Run was clicked.
    const fixedSeatConfigs = seatConfigs;
    const randomPool = centerEffect === "random" ? randomCenterEffectPool(playerCount) : null;
    const hardOptions = { ...DEFAULT_TWO_PLY_OPTIONS, timeBudgetMs: clampedHardBudgetMs };
    let completed = 0;
    let lastYieldAt = performance.now();

    for (let i = 0; i < clampedGameCount; i++) {
      const effect = centerEffect === "random" ? randomPool![Math.floor(Math.random() * randomPool!.length)] : centerEffect;
      if (mode === "shuffle") {
        simulateArenaGame(playerCount, effect, selectedDifficulties, workingStats, Math.random, hardOptions);
      } else {
        simulateFixedSeatArenaGame(effect, fixedSeatConfigs, workingSeatBuckets, Math.random);
      }
      completed++;

      if (completed === gameCount || performance.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
        setProgress(completed);
        if (mode === "shuffle") setStats({ ...workingStats });
        else setSeatBuckets([...workingSeatBuckets]);
        if (cancelRef.current) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYieldAt = performance.now();
      }
    }

    setRunning(false);
    runInProgressRef.current = false;
  }

  // Clearing the underlying storage isn't strictly necessary -- the persist effect
  // above re-saves right after these setState calls anyway, this time with fresh/
  // empty buckets -- but it does mean the "last saved" write is never a stale
  // pre-reset blob if something interrupts the very next render.
  function handleReset() {
    setStats(createEmptyArenaStats());
    setSeatBuckets(createEmptyFixedSeatArenaStats(seatConfigs.length));
    setProgress(0);
    resetArenaState();
  }

  const { byDifficulty, byPosition } = summarizeArenaStats(stats);
  const bySeat = summarizeFixedSeatArenaStats(seatConfigs, seatBuckets);

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

        <div className="flex gap-1.5 text-sm">
          <button
            onClick={() => setMode("shuffle")}
            disabled={running}
            title="Every game, seats get a random shuffle of the checked difficulties -- answers 'does a difficulty LABEL win more,' with the shuffle keeping no single seat's results trustworthy on their own."
            className={`rounded-full border px-3 py-1 text-xs whitespace-nowrap disabled:opacity-50 ${
              mode === "shuffle"
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            }`}
          >
            Shuffle difficulties
          </button>
          <button
            onClick={() => setMode("fixed")}
            disabled={running}
            title="Each seat keeps one fixed strategy + config for the whole batch -- answers 'does THIS specific configuration perform differently,' e.g. Hard-Fast at 150ms/6 candidates vs. real Hard at 250ms/8."
            className={`rounded-full border px-3 py-1 text-xs whitespace-nowrap disabled:opacity-50 ${
              mode === "fixed"
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            }`}
          >
            Fixed per-seat config
          </button>
        </div>

        <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 text-sm text-zinc-600 sm:grid-cols-[auto_1fr_auto_1fr] dark:text-zinc-400">
          <label htmlFor="arena-players">Players</label>
          <select
            id="arena-players"
            value={playerCount}
            disabled={running}
            onChange={(e) => handlePlayerCountChange(Number(e.target.value))}
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

        {mode === "shuffle" ? (
          <>
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
          </>
        ) : (
          <>
            <p className="mt-2 text-xs font-medium text-zinc-500 uppercase dark:text-zinc-400">
              Per-seat config (fixed for the whole batch -- starting position still rotates each game)
            </p>
            <div className="flex flex-col gap-2">
              {seatConfigs.map((config, seatIndex) => (
                <SeatConfigRow key={seatIndex} seatIndex={seatIndex} config={config} disabled={running} onChange={(c) => updateSeatConfig(seatIndex, c)} />
              ))}
            </div>
          </>
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

      {mode === "shuffle" ? (
        <div className="flex w-full max-w-3xl flex-col gap-4 sm:flex-row">
          <ResultsTable title="By difficulty" rows={byDifficulty} firstColumnLabel="Difficulty" />
          <ResultsTable title="By starting position" rows={byPosition} firstColumnLabel="Position" />
        </div>
      ) : (
        <div className="w-full max-w-3xl">
          <SeatResultsTable rows={bySeat} />
        </div>
      )}
    </div>
  );
}
