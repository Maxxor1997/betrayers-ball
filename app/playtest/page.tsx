"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { BoardGrid } from "@/app/components/Board";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, randomCenterEffectPool, selectableCenterEffects } from "@/lib/content/centerEffects";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { ResolvedCard, resolveBoard } from "@/lib/engine/resolution";
import { CardBucket, CardId, CenterEffectId, GameState } from "@/lib/engine/types";
import { CardStats, CardStatsRow, createEmptyStats, simulateOneGame, simulateOneGameSteps, statsSummary, tallyGame } from "@/lib/playtest/cardStats";
import { loadStats, resetStats, saveStats } from "@/lib/playtest/store";
import { PlaySelf } from "./PlaySelf";

/** Same grouping CardCatalog uses -- keeps the two card listings visually consistent. */
const BUCKET_ORDER: CardBucket[] = ["Slam", "Engine", "Control"];

/** Games are simulated in batches of this size between UI-thread yields, so a large run stays responsive and cancelable instead of freezing the tab for its whole duration. */
const BATCH_SIZE = 25;

/** How many engine actions pass between live-board repaints while "watch games simulate" is on -- frequent enough to feel live, not so frequent it dominates a large run's time. */
const LIVE_SAMPLE_EVERY_ACTIONS = 3;

const EMPTY_KEYS = new Set<string>();

function fmt(n: number | null, decimals = 1): string {
  return n === null ? "—" : n.toFixed(decimals);
}

/** sim0/sim1/... (see cardStats.ts's simulateOneGame) -> "P1"/"P2"/... for the live board viewer, which has no real lobby to look names up in. */
function simPlayerLabel(id: string): string {
  const n = Number(id.replace("sim", ""));
  return Number.isNaN(n) ? id : `P${n + 1}`;
}

type SortKey = "name" | "bucket" | "played" | "own" | "final" | "placement";

function compareNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // never-played cards always sort last, regardless of direction
  if (b === null) return -1;
  return dir * (a - b);
}

/**
 * Reads localStorage synchronously (no window access during SSR), so this can't run
 * until after mount -- same mount-gate pattern /play and /join use for their own
 * client-only state (random shuffles there, localStorage here).
 */
export default function PlaytestPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-500">Loading…</div>;
  }
  return <Playtest />;
}

function Playtest() {
  const [stats, setStats] = useState<Record<CardId, CardStats>>(() => loadStats());
  const [playerCount, setPlayerCount] = useState(4);
  const [centerEffect, setCenterEffect] = useState<CenterEffectId | "random">("random");
  const [gameCount, setGameCount] = useState(500);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [watchLive, setWatchLive] = useState(true);
  const [liveState, setLiveState] = useState<GameState | null>(null);
  const [selfPlayedCount, setSelfPlayedCount] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("bucket");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  // Checked once per batch, not once per game -- cancel doesn't need to be instant,
  // just prompt (finishing the in-flight batch of BATCH_SIZE is fine).
  const cancelRef = useRef(false);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  function tallyOneGame(working: Record<CardId, CardStats>, finalState: GameState) {
    const result = resolveBoard(
      finalState.board,
      finalState.config.boardBounds,
      finalState.round,
      finalState.config.centerEffect,
      finalState.players.map((p) => p.id)
    );
    tallyGame(working, result.cards, finalState.result!.scores);
  }

  async function runSimulation() {
    setRunning(true);
    setProgress(0);
    setLiveState(null);
    cancelRef.current = false;
    // A working copy, mutated in place by tallyGame across the whole run for speed --
    // committed to React state (and localStorage) once per batch, not once per game,
    // so a few-thousand-game run doesn't trigger a few thousand re-renders.
    const working = loadStats();

    const randomPool = centerEffect === "random" ? randomCenterEffectPool(playerCount) : null;
    let actionsSinceSample = 0;

    for (let i = 0; i < gameCount; i++) {
      const effect = centerEffect === "random" ? randomPool![Math.floor(Math.random() * randomPool!.length)] : centerEffect;

      let finalState: GameState;
      if (watchLive) {
        // Steps through the game action-by-action instead of running it in one call,
        // so the board actually visible on screen keeps up with play instead of only
        // ever showing the previous game's finished result.
        const steps = simulateOneGameSteps(playerCount, effect, Math.random);
        let step = steps.next();
        while (!step.done) {
          if (++actionsSinceSample >= LIVE_SAMPLE_EVERY_ACTIONS) {
            actionsSinceSample = 0;
            setLiveState(step.value);
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (cancelRef.current) break;
          }
          step = steps.next();
        }
        // Cancelled mid-game -- this game never reached "ended" (state.result is still
        // null), so there's nothing valid to tally. Abandon it and stop the whole run,
        // rather than crash on a null result or silently skip the tally.
        if (!step.done) break;
        finalState = step.value;
        setLiveState(finalState);
      } else {
        finalState = simulateOneGame(playerCount, effect, Math.random);
      }

      tallyOneGame(working, finalState);

      if ((i + 1) % BATCH_SIZE === 0 || i === gameCount - 1) {
        setProgress(i + 1);
        setStats({ ...working });
        saveStats(working);
        if (cancelRef.current) break;
        // Yields to the browser between batches so the tab stays responsive/paintable
        // -- redundant with the per-action yield above when watchLive is on, but
        // still needed for the fast (non-watching) path.
        if (!watchLive) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    setRunning(false);
  }

  function handleReset() {
    resetStats();
    setStats(createEmptyStats());
    setConfirmingReset(false);
  }

  const rows = statsSummary(stats).sort((a, b) => {
    switch (sortKey) {
      case "name":
        return sortDir * CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name);
      case "bucket": {
        const diff = BUCKET_ORDER.indexOf(CARD_DEFS[a.cardId].bucket) - BUCKET_ORDER.indexOf(CARD_DEFS[b.cardId].bucket);
        return sortDir * (diff !== 0 ? diff : CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name));
      }
      case "played":
        return sortDir * (a.played - b.played);
      case "own":
        return compareNullable(a.avgOwnScore, b.avgOwnScore, sortDir);
      case "final":
        return compareNullable(a.avgFinalScore, b.avgFinalScore, sortDir);
      case "placement":
        return compareNullable(a.avgPlacement, b.avgPlacement, sortDir);
    }
  });
  const totalPlayed = rows.reduce((sum, r) => sum + r.played, 0);

  function onSelfGameEnded(cards: ResolvedCard[], scores: Record<string, number>) {
    const working = loadStats();
    tallyGame(working, cards, scores);
    saveStats(working);
    setStats(working);
    setSelfPlayedCount((n) => n + 1);
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-4xl flex-col gap-2">
        <div className="flex w-full items-center justify-between gap-2">
          <h1 className="text-lg font-semibold sm:text-xl">
            Board Game <span className="font-normal text-zinc-500">— playtest stats</span>
          </h1>
          <ThemeToggle />
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5">
          <Link
            href="/"
            className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            ◀ Home
          </Link>
        </div>
      </header>

      <div className="flex w-full max-w-4xl flex-col gap-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
        <p className="text-sm font-medium">Simulate AI-only games</p>
        <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 text-sm text-zinc-600 sm:grid-cols-[auto_1fr_auto_1fr] dark:text-zinc-400">
          <label htmlFor="pt-players">Players</label>
          <select
            id="pt-players"
            value={playerCount}
            disabled={running}
            onChange={(e) => setPlayerCount(Number(e.target.value))}
            className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          >
            {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <label htmlFor="pt-center">Location</label>
          <select
            id="pt-center"
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
          <label htmlFor="pt-games">Games</label>
          <input
            id="pt-games"
            type="number"
            min={1}
            max={50000}
            value={gameCount}
            disabled={running}
            onChange={(e) => setGameCount(Math.max(1, Math.min(50000, Number(e.target.value) || 1)))}
            className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          />
          <label htmlFor="pt-watch" className="flex items-center gap-1.5">
            <input
              id="pt-watch"
              type="checkbox"
              checked={watchLive}
              disabled={running}
              onChange={(e) => setWatchLive(e.target.checked)}
              className="disabled:opacity-50"
            />
            Watch a board while simulating
          </label>
          <div className="flex items-center gap-2">
            {running ? (
              <>
                <span className="text-xs whitespace-nowrap">
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
              <button
                onClick={runSimulation}
                className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-black"
              >
                Run simulation
              </button>
            )}
          </div>
        </div>
      </div>

      {watchLive && liveState && (
        <div className="flex w-full max-w-sm flex-col items-center gap-2">
          <p className="text-xs text-zinc-500">
            Watching a simulated game — {liveState.phase === "ended" ? "finished" : `round ${liveState.round} of ${liveState.config.roundCap}`}
          </p>
          <BoardGrid
            state={liveState}
            viewerId=""
            nameFor={simPlayerLabel}
            legalCellKeys={EMPTY_KEYS}
            flipTargetIds={EMPTY_KEYS}
            selectedInstanceId={null}
            dragOverKey={null}
            revealAll
            highlightedCardId={null}
            onCellClick={() => {}}
            onCellDragOver={() => {}}
            onCellDragLeave={() => {}}
            onCellDrop={() => {}}
          />
        </div>
      )}

      <div className="flex w-full max-w-4xl items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">
          {totalPlayed === 0 ? "No games tallied yet." : `${totalPlayed.toLocaleString()} card placements tallied across every run so far.`}
        </p>
        {confirmingReset ? (
          <div className="flex shrink-0 items-center gap-2 text-xs">
            <span className="text-zinc-500">Clear all tallied stats?</span>
            <button onClick={handleReset} className="rounded-full bg-red-600 px-3 py-1 text-white hover:bg-red-700">
              Reset
            </button>
            <button
              onClick={() => setConfirmingReset(false)}
              className="rounded-full border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingReset(true)}
            disabled={running}
            className="shrink-0 rounded-full border border-zinc-300 px-3 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Reset stats
          </button>
        )}
      </div>

      <div className="w-full max-w-4xl overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
              <SortableHeader label="Card" sortKey="name" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableHeader label="Bucket" sortKey="bucket" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
              <SortableHeader label="Played" sortKey="played" activeKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <SortableHeader
                label="Own score"
                sortKey="own"
                activeKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                align="right"
                title="Base + only this card's own conditional effects, excluding neighbor/center-effect deltas"
              />
              <SortableHeader
                label="Final score"
                sortKey="final"
                activeKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                align="right"
                title="Full resolved value as actually scored, including neighbor and center effects"
              />
              <SortableHeader
                label="Avg placement"
                sortKey="placement"
                activeKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                align="right"
                title="Average final placement (1st/2nd/...) of the player who played this card"
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((row: CardStatsRow) => (
              <tr key={row.cardId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                <td className="px-3 py-1.5 font-medium">{CARD_DEFS[row.cardId].name}</td>
                <td className="px-3 py-1.5 text-zinc-500 dark:text-zinc-400">{CARD_DEFS[row.cardId].bucket}</td>
                <td className="px-3 py-1.5 text-right">{row.played}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.avgOwnScore)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.avgFinalScore)}</td>
                <td className="px-3 py-1.5 text-right">{fmt(row.avgPlacement, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex w-full max-w-4xl flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Play it yourself</p>
          {selfPlayedCount > 0 && (
            <p className="text-xs text-zinc-500">
              {selfPlayedCount} game{selfPlayedCount === 1 ? "" : "s"} you&rsquo;ve played this session, tallied into the same stats above.
            </p>
          )}
        </div>
        <PlaySelf playerCount={playerCount} centerEffect={centerEffect} onGameEnded={onSelfGameEnded} />
      </div>
    </div>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onClick,
  align = "left",
  title,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: 1 | -1;
  onClick: (key: SortKey) => void;
  align?: "left" | "right";
  title?: string;
}) {
  const active = sortKey === activeKey;
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`} title={title}>
      <button
        onClick={() => onClick(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-200 ${active ? "text-zinc-700 dark:text-zinc-200" : ""}`}
      >
        {label}
        <span className="w-2.5 text-[9px]">{active ? (dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}
