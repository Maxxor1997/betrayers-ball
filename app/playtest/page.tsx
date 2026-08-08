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
import {
  CardStatsRow,
  createEmptyStats,
  overallAvgRoundLength,
  PlaytestStats,
  simulateOneGame,
  simulateOneGameSteps,
  StatsBucket,
  statsSummary,
  tallyGame,
} from "@/lib/playtest/cardStats";
import { loadStats, resetStats, saveStats } from "@/lib/playtest/store";
import { PlaySelf } from "./PlaySelf";

/** Same grouping CardCatalog uses -- keeps the two card listings visually consistent. */
const BUCKET_ORDER: CardBucket[] = ["Slam", "Engine", "Control"];

/** Games are simulated in batches of this size between UI-thread yields, so a large run stays responsive and cancelable instead of freezing the tab for its whole duration. */
const BATCH_SIZE = 25;

/** How many engine actions pass between live-board repaints while "watch games simulate" is on -- frequent enough to feel live, not so frequent it dominates a large run's time. */
const LIVE_SAMPLE_EVERY_ACTIONS = 3;

const EMPTY_KEYS = new Set<string>();

const ALL_PLAYER_COUNTS = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i);

function fmt(n: number | null, decimals = 1): string {
  return n === null ? "—" : n.toFixed(decimals);
}

/** For a delta column (own score vs. base) -- an explicit "+" on non-negative values, since a bare "3.0" reads as an absolute number, not a change. */
function fmtSigned(n: number | null, decimals = 1): string {
  if (n === null) return "—";
  return n >= 0 ? `+${n.toFixed(decimals)}` : n.toFixed(decimals);
}

function fmtPercent(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

/** Own score minus the card's own printed base -- see CardStatsRow.avgOwnScore's doc comment for what "own" already excludes; this just re-centers it on 0 so the table reads as "how much this card's own conditions typically add or subtract" rather than an absolute number you have to compare to the base yourself. */
function ownScoreDelta(row: CardStatsRow): number | null {
  return row.avgOwnScore === null ? null : row.avgOwnScore - CARD_DEFS[row.cardId].base;
}

/**
 * The heatmap's "Value" metric -- a single number meant to read as "what is this card
 * actually worth to play", using whichever half of its worth is the real story for its
 * bucket: a Control card's own base rarely moves on its own (see cardStats.ts's
 * disruptionFor), so its value is base + what it does to the average opponent; every
 * other card's value already comes from its own base + conditions (avgOwnScore, which
 * deliberately excludes anything a neighbor did *to* it -- a debuff from someone
 * else's Earthshaker isn't this card's own worth, it's board misfortune).
 */
function cardValueMetric(row: CardStatsRow): number | null {
  const def = CARD_DEFS[row.cardId];
  if (def.bucket === "Control") return row.avgDisruption === null ? null : def.base + row.avgDisruption;
  return row.avgOwnScore;
}

/**
 * How much this card actually bends real game outcomes, weighted by how often it
 * shows up -- avgPlacementDelta is the average placement swing *conditional on being
 * played*; multiplying by playRate turns that into the unconditional expected swing
 * across a random game (a card that's never played contributes exactly 0, same as one
 * that's played constantly but does nothing). Negated so positive reads as "strong and
 * common" (worth a balance look) and negative as "actively bad and common" (a trap
 * card, a different but still real problem) -- a card that's merely rare stays near 0
 * either way, regardless of how strong it is when it *does* get played, since it's too
 * infrequent to be swinging the overall picture.
 */
function impactMetric(row: CardStatsRow): number | null {
  return row.avgPlacementDelta === null || row.playRate === null ? null : -row.avgPlacementDelta * row.playRate;
}

/** Plain mean of cardValueMetric across every card with a value at this player count (rows never played there are excluded, not counted as 0) -- for the "Card value" chart, one aggregate number per player count instead of picking a single card. */
function averageCardValueAt(rowsForPlayerCount: Map<CardId, CardStatsRow> | undefined): number | null {
  if (!rowsForPlayerCount) return null;
  const values = [...rowsForPlayerCount.values()].map(cardValueMetric).filter((v): v is number => v !== null);
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Same bucket-then-name ordering used everywhere in this file (the table's default sort, and the heatmap's fixed row order). */
function byBucketThenName(a: CardStatsRow, b: CardStatsRow): number {
  const diff = BUCKET_ORDER.indexOf(CARD_DEFS[a.cardId].bucket) - BUCKET_ORDER.indexOf(CARD_DEFS[b.cardId].bucket);
  return diff !== 0 ? diff : CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name);
}

/** Markdown table of the currently-sorted rows, for pasting elsewhere (bug reports, balance discussion) -- same values shown on screen, in the same order. */
function buildStatsMarkdown(rows: CardStatsRow[], overallRoundLength: number | null): string {
  const lines = [
    `Overall average round length: ${fmt(overallRoundLength, 2)}`,
    "",
    "| Card | Bucket | Played | Own Δ base | Final score | Placement Δ avg | Avg round length | Disruption | Impact |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${CARD_DEFS[row.cardId].name} | ${CARD_DEFS[row.cardId].bucket} | ${fmtPercent(row.playRate)} (${row.played}/${row.copiesInDeck}) | ${fmtSigned(ownScoreDelta(row))} | ${fmt(row.avgFinalScore)} | ${fmtSigned(row.avgPlacementDelta, 2)} | ${fmt(row.avgRoundLength, 2)} | ${fmtSigned(row.avgDisruption)} | ${fmtSigned(impactMetric(row), 3)} |`
    );
  }
  return lines.join("\n") + "\n";
}

/** sim0/sim1/... (see cardStats.ts's simulateOneGame) -> "P1"/"P2"/... for the live board viewer, which has no real lobby to look names up in. */
function simPlayerLabel(id: string): string {
  const n = Number(id.replace("sim", ""));
  return Number.isNaN(n) ? id : `P${n + 1}`;
}

type SortKey = "name" | "bucket" | "played" | "own" | "final" | "placement" | "roundLength" | "disruption" | "impact";

/**
 * The heatmap's row order is deliberately independent of the flat table's sortKey
 * (see heatmapRows's own doc comment) -- "bucket" is the default bucket-then-name
 * order (no dedicated header of its own, just the starting state), "name" is plain
 * alphabetical, toggled from the heatmap table's own "Card" column header.
 */
type HeatmapSortKey = "bucket" | "name";

function compareNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // never-played cards always sort last, regardless of direction
  if (b === null) return -1;
  return dir * (a - b);
}

type HeatMetric = "placement" | "impact" | "playRate" | "value" | "own" | "final" | "disruption" | "roundLength";

const HEAT_METRIC_LABELS: Record<HeatMetric, string> = {
  placement: "Placement Δ avg",
  impact: "Impact (strength × play rate)",
  playRate: "Played",
  value: "Value (base + effect)",
  own: "Own Δ base",
  final: "Final score",
  disruption: "Disruption",
  roundLength: "Avg round length",
};

/** Only "placement" has a real notion of better/worse (lower rank number wins) -- every other metric is purely informational, so its heatmap coloring is just a plain magnitude scale, not a judgment. */
function heatMetricPolarity(metric: HeatMetric): "lowIsGood" | "neutral" {
  return metric === "placement" ? "lowIsGood" : "neutral";
}

function heatMetricValue(row: CardStatsRow | undefined, metric: HeatMetric): number | null {
  if (!row) return null;
  switch (metric) {
    case "placement":
      return row.avgPlacementDelta;
    case "playRate":
      return row.playRate;
    case "own":
      return ownScoreDelta(row);
    case "final":
      return row.avgFinalScore;
    case "roundLength":
      return row.avgRoundLength;
    case "disruption":
      return row.avgDisruption;
    case "value":
      return cardValueMetric(row);
    case "impact":
      return impactMetric(row);
  }
}

function heatMetricFormat(row: CardStatsRow | undefined, metric: HeatMetric): string {
  if (!row) return "—";
  switch (metric) {
    case "placement":
      return fmtSigned(row.avgPlacementDelta, 2);
    case "playRate":
      return fmtPercent(row.playRate);
    case "own":
      return fmtSigned(ownScoreDelta(row));
    case "final":
      return fmt(row.avgFinalScore);
    case "roundLength":
      return fmt(row.avgRoundLength, 2);
    case "disruption":
      return fmtSigned(row.avgDisruption);
    case "value":
      return fmt(cardValueMetric(row));
    case "impact":
      return fmtSigned(impactMetric(row), 3);
  }
}

/**
 * Green (good) -> red (bad) for "lowIsGood" metrics (placement); a plain light->dark
 * blue magnitude scale for everything else, which has no inherent good/bad direction.
 * Semi-transparent either way so the underlying light/dark page background still shows
 * through and text stays legible.
 *
 * Colored by `rank` (this card's ordinal position among the other cards *at the same
 * player count*), not the raw value against a single global min/max -- a metric like
 * average placement has a completely different possible range per player count (best
 * is always 1st, but worst is playerCount-th), so coloring every column off one shared
 * scale would paint 2p almost entirely green and 8p almost entirely red regardless of
 * how any card is actually doing relative to its own table. Ranking within each column
 * fixes that, and as a side effect stops one outlier value from compressing everything
 * else into a narrow, hard-to-distinguish color band.
 */
function heatColorByRank(rank: number, columnSize: number, polarity: "lowIsGood" | "neutral"): string {
  const t = columnSize <= 1 ? 0 : (rank - 1) / (columnSize - 1);
  if (polarity === "lowIsGood") {
    const r = Math.round(34 + (239 - 34) * t);
    const g = Math.round(197 + (68 - 197) * t);
    const b = Math.round(94 + (68 - 94) * t);
    return `rgba(${r}, ${g}, ${b}, 0.4)`;
  }
  return `rgba(59, 130, 246, ${(0.08 + t * 0.42).toFixed(2)})`;
}

/** Markdown table of one heatmap metric across every available player count, for the same "copy" workflow the flat table already has. */
function buildHeatmapMarkdown(rows: CardStatsRow[], playerCounts: number[], lookup: Map<number, Map<CardId, CardStatsRow>>, metric: HeatMetric): string {
  const lines = [
    `${HEAT_METRIC_LABELS[metric]} by player count`,
    "",
    `| Card | ${playerCounts.map((pc) => `${pc}p`).join(" | ")} |`,
    `|---|${playerCounts.map(() => "---").join("|")}|`,
  ];
  for (const row of rows) {
    const cells = playerCounts.map((pc) => heatMetricFormat(lookup.get(pc)?.get(row.cardId), metric));
    lines.push(`| ${CARD_DEFS[row.cardId].name} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

/**
 * The comprehensive export -- everything on the page in one paste, regardless of
 * which view happens to be showing: the flat all-player-counts table, the average
 * round length by player count breakdown, and every heatmap metric's own
 * player-count table. Separate from buildStatsMarkdown (the flat table alone) and
 * buildHeatmapMarkdown (one metric alone), which stay available as focused exports.
 */
function buildEverythingMarkdown(
  rows: CardStatsRow[],
  overallRoundLength: number | null,
  stats: PlaytestStats,
  heatmapRows: CardStatsRow[],
  availablePlayerCounts: number[],
  heatmapLookup: Map<number, Map<CardId, CardStatsRow>>
): string {
  const sections = [buildStatsMarkdown(rows, overallRoundLength)];

  if (availablePlayerCounts.length > 0) {
    const roundLengthLines = [
      "Average round length by player count",
      "",
      "| Player count | Avg round length |",
      "|---|---|",
      ...availablePlayerCounts.map((pc) => `| ${pc}p | ${fmt(overallAvgRoundLength(stats.byPlayerCount[pc]), 2)} |`),
    ];
    sections.push(roundLengthLines.join("\n") + "\n");

    for (const metric of Object.keys(HEAT_METRIC_LABELS) as HeatMetric[]) {
      sections.push(buildHeatmapMarkdown(heatmapRows, availablePlayerCounts, heatmapLookup, metric));
    }
  }

  return sections.join("\n---\n\n");
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
  const [stats, setStats] = useState<PlaytestStats>(() => loadStats());
  const [playerCount, setPlayerCount] = useState(4);
  const [runAllPlayerCounts, setRunAllPlayerCounts] = useState(false);
  const [centerEffect, setCenterEffect] = useState<CenterEffectId | "random">("random");
  const [gameCount, setGameCount] = useState(500);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pendingRunConfirm, setPendingRunConfirm] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [watchLive, setWatchLive] = useState(false);
  const [liveState, setLiveState] = useState<GameState | null>(null);
  const [selfPlayedCount, setSelfPlayedCount] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("bucket");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [heatmapSortKey, setHeatmapSortKey] = useState<HeatmapSortKey>("bucket");
  const [heatmapSortDir, setHeatmapSortDir] = useState<1 | -1>(1);
  const [chartMode, setChartMode] = useState<"roundLength" | "cardValue">("roundLength");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [copyTableFeedback, setCopyTableFeedback] = useState(false);
  const [view, setView] = useState<"table" | "heatmap">("table");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("placement");
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

  function toggleHeatmapSort(key: HeatmapSortKey) {
    if (key === heatmapSortKey) setHeatmapSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setHeatmapSortKey(key);
      setHeatmapSortDir(1);
    }
  }

  function tallyOneGame(working: PlaytestStats, finalState: GameState) {
    const result = resolveBoard(
      finalState.board,
      finalState.config.boardBounds,
      finalState.round,
      finalState.config.centerEffect,
      finalState.players.map((p) => p.id)
    );
    tallyGame(working, result.cards, finalState.result!.scores, finalState.config.playerCount, finalState.round);
  }

  /** `startFresh` clears any already-tallied data before this run instead of adding to it -- see the pre-run confirmation popup below, which is the only place that ever passes true. */
  async function runSimulation(startFresh: boolean) {
    setRunning(true);
    setProgress(0);
    setLiveState(null);
    cancelRef.current = false;
    // A working copy, mutated in place by tallyGame across the whole run for speed --
    // committed to React state (and localStorage) once per batch, not once per game,
    // so a few-thousand-game run doesn't trigger a few thousand re-renders.
    const working = startFresh ? createEmptyStats() : loadStats();

    const playerCounts = runAllPlayerCounts ? ALL_PLAYER_COUNTS : [playerCount];
    const totalGames = gameCount * playerCounts.length;
    let completed = 0;

    runLoop: for (const pc of playerCounts) {
      const randomPool = centerEffect === "random" ? randomCenterEffectPool(pc) : null;
      let actionsSinceSample = 0;

      for (let i = 0; i < gameCount; i++) {
        const effect = centerEffect === "random" ? randomPool![Math.floor(Math.random() * randomPool!.length)] : centerEffect;

        let finalState: GameState;
        if (watchLive) {
          // Steps through the game action-by-action instead of running it in one call,
          // so the board actually visible on screen keeps up with play instead of only
          // ever showing the previous game's finished result.
          const steps = simulateOneGameSteps(pc, effect, Math.random);
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
          // Cancelled mid-game -- this game never reached "ended" (state.result is
          // still null), so there's nothing valid to tally. Abandon it and stop the
          // whole run (every remaining player count too), rather than crash on a null
          // result or silently skip the tally.
          if (!step.done) break runLoop;
          finalState = step.value;
          setLiveState(finalState);
        } else {
          finalState = simulateOneGame(pc, effect, Math.random);
        }

        tallyOneGame(working, finalState);
        completed++;

        if (completed % BATCH_SIZE === 0 || completed === totalGames) {
          setProgress(completed);
          setStats({ ...working });
          saveStats(working);
          if (cancelRef.current) break runLoop;
          // Yields to the browser between batches so the tab stays responsive/paintable
          // -- redundant with the per-action yield above when watchLive is on, but
          // still needed for the fast (non-watching) path.
          if (!watchLive) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    setRunning(false);
  }

  function handleRunClick() {
    // Nothing to conflict with yet -- just run, no need to ask "add or start fresh".
    if (totalPlayed === 0) runSimulation(false);
    else setPendingRunConfirm(true);
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
      case "bucket":
        return sortDir * byBucketThenName(a, b);
      case "played":
        return compareNullable(a.playRate, b.playRate, sortDir);
      case "own":
        return compareNullable(ownScoreDelta(a), ownScoreDelta(b), sortDir);
      case "final":
        return compareNullable(a.avgFinalScore, b.avgFinalScore, sortDir);
      case "placement":
        return compareNullable(a.avgPlacementDelta, b.avgPlacementDelta, sortDir);
      case "roundLength":
        return compareNullable(a.avgRoundLength, b.avgRoundLength, sortDir);
      case "disruption":
        return compareNullable(a.avgDisruption, b.avgDisruption, sortDir);
      case "impact":
        return compareNullable(impactMetric(a), impactMetric(b), sortDir);
    }
  });
  const totalPlayed = rows.reduce((sum, r) => sum + r.played, 0);
  const overallRoundLength = overallAvgRoundLength(stats);
  const totalGamesConfigured = gameCount * (runAllPlayerCounts ? ALL_PLAYER_COUNTS.length : 1);

  // Heatmap data -- every available player count's own StatsBucket, summarized and
  // indexed by cardId, plus a row order independent of the flat table's own sort (the
  // heatmap's whole point is comparing across player counts, so its rows shouldn't
  // shuffle just because you sorted the flat table by a different column) -- default
  // bucket-then-name, or plain alphabetical via the heatmap table's own "Card" header
  // (see HeatmapSortKey/toggleHeatmapSort), independently of either the flat table's
  // sort or which heat metric is currently selected.
  const availablePlayerCounts = Object.keys(stats.byPlayerCount)
    .map(Number)
    .sort((a, b) => a - b);
  const heatmapRows = [...rows].sort((a, b) =>
    heatmapSortKey === "name" ? heatmapSortDir * CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name) : heatmapSortDir * byBucketThenName(a, b)
  );
  const heatmapLookup = new Map<number, Map<CardId, CardStatsRow>>(
    availablePlayerCounts.map((pc) => [pc, new Map(statsSummary(stats.byPlayerCount[pc] as StatsBucket).map((r) => [r.cardId, r]))])
  );
  const heatPolarity = heatMetricPolarity(heatMetric);
  // Rank (1 = lowest value) of every card within its own player-count column, for the
  // selected metric -- see heatColorByRank's doc comment for why coloring is relative
  // to the column, not one shared scale across every player count.
  const heatRanksByColumn = new Map<number, Map<CardId, number>>();
  const heatColumnSizes = new Map<number, number>();
  for (const pc of availablePlayerCounts) {
    const colLookup = heatmapLookup.get(pc)!;
    const ranked = heatmapRows
      .map((row) => ({ cardId: row.cardId, value: heatMetricValue(colLookup.get(row.cardId), heatMetric) }))
      .filter((e): e is { cardId: CardId; value: number } => e.value !== null)
      .sort((a, b) => a.value - b.value);
    heatRanksByColumn.set(
      pc,
      new Map(ranked.map((e, i) => [e.cardId, i + 1]))
    );
    heatColumnSizes.set(pc, ranked.length);
  }

  /** The top button -- everything on the page, regardless of which view is active. */
  function copyEverything() {
    const text = buildEverythingMarkdown(rows, overallRoundLength, stats, heatmapRows, availablePlayerCounts, heatmapLookup);
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    });
  }

  /** The button next to the flat table -- just that table, not the heatmap/round-length breakdowns too. */
  function copyTable() {
    navigator.clipboard.writeText(buildStatsMarkdown(rows, overallRoundLength)).then(() => {
      setCopyTableFeedback(true);
      setTimeout(() => setCopyTableFeedback(false), 1500);
    });
  }

  function onSelfGameEnded(cards: ResolvedCard[], scores: Record<string, number>, roundsPlayed: number) {
    const working = loadStats();
    tallyGame(working, cards, scores, playerCount, roundsPlayed);
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
            disabled={running || runAllPlayerCounts}
            onChange={(e) => setPlayerCount(Number(e.target.value))}
            className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          >
            {ALL_PLAYER_COUNTS.map((n) => (
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
            {selectableCenterEffects(runAllPlayerCounts ? MAX_PLAYERS : playerCount).map((id) => (
              <option key={id} value={id}>
                {CENTER_EFFECTS[id].label}
              </option>
            ))}
          </select>
          <label htmlFor="pt-games">Games{runAllPlayerCounts ? " (per player count)" : ""}</label>
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
          <label htmlFor="pt-all-counts" className="flex items-center gap-1.5">
            <input
              id="pt-all-counts"
              type="checkbox"
              checked={runAllPlayerCounts}
              disabled={running}
              onChange={(e) => setRunAllPlayerCounts(e.target.checked)}
              className="disabled:opacity-50"
            />
            All player counts ({MIN_PLAYERS}p–{MAX_PLAYERS}p)
          </label>
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
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={totalGamesConfigured}
                  aria-valuenow={progress}
                  className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                >
                  <div
                    className="h-full rounded-full bg-zinc-900 transition-[width] duration-150 dark:bg-zinc-100"
                    style={{ width: `${totalGamesConfigured > 0 ? Math.min(100, (progress / totalGamesConfigured) * 100) : 0}%` }}
                  />
                </div>
                <span className="text-xs whitespace-nowrap">
                  {progress} / {totalGamesConfigured}
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
                onClick={handleRunClick}
                className="shrink-0 rounded-full bg-zinc-900 px-4 py-1.5 text-xs whitespace-nowrap text-white dark:bg-zinc-100 dark:text-black"
              >
                Run simulation
              </button>
            )}
          </div>
        </div>
      </div>

      {pendingRunConfirm && (
        <div className="fixed top-20 left-1/2 z-50 w-[min(90vw,24rem)] -translate-x-1/2 rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 font-medium">You already have tallied stats</p>
          <p className="mb-2 text-xs text-zinc-500">
            {totalPlayed.toLocaleString()} card placements across {stats.overall.gamesTallied.toLocaleString()} games so far. Add this run to that
            data, or clear it and start fresh?
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={() => setPendingRunConfirm(false)}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setPendingRunConfirm(false);
                // Clears the table immediately -- runSimulation's own first React-state
                // commit doesn't land until the first batch of games finishes, which
                // would otherwise leave the old (stale) results on screen for however
                // long that takes.
                resetStats();
                setStats(createEmptyStats());
                runSimulation(true);
              }}
              className="rounded-full border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              Start fresh
            </button>
            <button
              onClick={() => {
                setPendingRunConfirm(false);
                runSimulation(false);
              }}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black"
            >
              Add to existing
            </button>
          </div>
        </div>
      )}

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

      <div className="flex w-full max-w-4xl flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">
          {totalPlayed === 0
            ? "No games tallied yet."
            : `${totalPlayed.toLocaleString()} card placements across ${stats.overall.gamesTallied.toLocaleString()} games so far -- averaging ${fmt(overallRoundLength, 2)} rounds/game.`}
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
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-full border border-zinc-300 text-xs dark:border-zinc-700">
              <button
                onClick={() => setView("table")}
                className={`px-3 py-1 whitespace-nowrap ${view === "table" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
              >
                Table
              </button>
              <button
                onClick={() => setView("heatmap")}
                className={`px-3 py-1 whitespace-nowrap ${view === "heatmap" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
              >
                Heatmap
              </button>
            </div>
            <button
              onClick={copyTable}
              disabled={totalPlayed === 0}
              title="Copies just the flat table, regardless of which view is currently showing"
              className="shrink-0 rounded-full border border-zinc-300 px-3 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {copyTableFeedback ? "Copied!" : "Copy table"}
            </button>
            <button
              onClick={copyEverything}
              disabled={totalPlayed === 0}
              title="Copies the flat table, the round-length-by-player-count breakdown, and every heatmap metric's table -- everything, not just the current view"
              className="shrink-0 rounded-full border border-zinc-300 px-3 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {copyFeedback ? "Copied!" : "Copy everything"}
            </button>
            <button
              onClick={() => setConfirmingReset(true)}
              disabled={running}
              className="shrink-0 rounded-full border border-zinc-300 px-3 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Reset stats
            </button>
          </div>
        )}
      </div>

      {view === "table" ? (
        <div className="w-full max-w-4xl overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                <SortableHeader label="Card" sortKey="name" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHeader label="Bucket" sortKey="bucket" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHeader
                  label="Played"
                  sortKey="played"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  align="right"
                  title="Times placed on the board, as a share of every copy of this card that's existed across every tallied game -- scaled so a card with more printed copies doesn't just look more 'played' for having more copies"
                />
                <SortableHeader
                  label="Own Δ base"
                  sortKey="own"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  align="right"
                  title="Base + only this card's own conditional effects (excluding neighbor/center-effect deltas), shown as +/- versus the card's printed base value"
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
                  label="Placement Δ avg"
                  sortKey="placement"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  align="right"
                  title="Average (placement rank - the random-baseline rank for that game's player count), e.g. baseline is 2.5 at 4p, 4.5 at 8p -- lets placement be compared fairly across a mix of player counts. Negative means better than a random seat would average; positive means worse."
                />
                <SortableHeader
                  label="Avg round length"
                  sortKey="roundLength"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  align="right"
                  title={`Average length (in rounds) of games this card appeared in. Overall average across every tallied game: ${fmt(overallRoundLength, 2)}`}
                />
                <SortableHeader
                  label="Disruption"
                  sortKey="disruption"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  align="right"
                  title="Average net damage dealt to a single average opponent, per appearance -- damage to opponents' cards minus damage to this card's own side, divided by opponent count. Always 0 for a card with no outgoing effect on other cards."
                />
                <SortableHeader
                  label="Impact"
                  sortKey="impact"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  align="right"
                  title="-Placement Δ avg × play rate -- the unconditional expected placement swing this card contributes across a random game. High and positive means strong AND common (worth a balance look); near 0 means either weak or rare (a rare-but-strong card is 'situational', not broken); negative means common but actively bad (a trap card)."
                />
              </tr>
            </thead>
            <tbody>
              {rows.map((row: CardStatsRow) => (
                <tr key={row.cardId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-1.5 font-medium">{CARD_DEFS[row.cardId].name}</td>
                  <td className="px-3 py-1.5 text-zinc-500 dark:text-zinc-400">{CARD_DEFS[row.cardId].bucket}</td>
                  <td className="px-3 py-1.5 text-right" title={`${row.played} / ${row.copiesInDeck} copies`}>
                    {fmtPercent(row.playRate)}
                  </td>
                  <td className="px-3 py-1.5 text-right">{fmtSigned(ownScoreDelta(row))}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(row.avgFinalScore)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtSigned(row.avgPlacementDelta, 2)}</td>
                  <td className="px-3 py-1.5 text-right">{fmt(row.avgRoundLength, 2)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtSigned(row.avgDisruption)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtSigned(impactMetric(row), 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex w-full max-w-4xl flex-col gap-3">
          <div className="flex self-start overflow-hidden rounded-full border border-zinc-300 text-xs dark:border-zinc-700">
            <button
              onClick={() => setChartMode("roundLength")}
              className={`px-3 py-1 whitespace-nowrap ${chartMode === "roundLength" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
            >
              Round length
            </button>
            <button
              onClick={() => setChartMode("cardValue")}
              className={`px-3 py-1 whitespace-nowrap ${chartMode === "cardValue" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
            >
              Card value
            </button>
          </div>
          {chartMode === "roundLength" ? (
            <BarChartByPlayerCount
              title="Average round length by player count"
              counts={availablePlayerCounts}
              values={availablePlayerCounts.map((pc) => overallAvgRoundLength(stats.byPlayerCount[pc]))}
            />
          ) : (
            <BarChartByPlayerCount
              title="Average card value by player count"
              counts={availablePlayerCounts}
              values={availablePlayerCounts.map((pc) => averageCardValueAt(heatmapLookup.get(pc)))}
            />
          )}
          <label htmlFor="pt-heat-metric" className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            Color by
            <select
              id="pt-heat-metric"
              value={heatMetric}
              onChange={(e) => setHeatMetric(e.target.value as HeatMetric)}
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm dark:border-zinc-700"
            >
              {(Object.keys(HEAT_METRIC_LABELS) as HeatMetric[]).map((m) => (
                <option key={m} value={m}>
                  {HEAT_METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          {availablePlayerCounts.length === 0 ? (
            <p className="text-sm text-zinc-500">Run a simulation to see the heatmap.</p>
          ) : (
            <div className="w-full overflow-x-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-300 bg-zinc-50 text-xs text-zinc-500 uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                    <SortableHeader
                      label="Card"
                      sortKey="name"
                      activeKey={heatmapSortKey}
                      dir={heatmapSortDir}
                      onClick={toggleHeatmapSort}
                      title="Sort alphabetically -- click again to reverse. Doesn't affect the flat table's own sort."
                    />
                    {availablePlayerCounts.map((pc) => (
                      <th key={pc} className="px-3 py-2 text-right">
                        {pc}p
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatmapRows.map((row) => (
                    <tr key={row.cardId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap">{CARD_DEFS[row.cardId].name}</td>
                      {availablePlayerCounts.map((pc) => {
                        const cellRow = heatmapLookup.get(pc)?.get(row.cardId);
                        const rank = heatRanksByColumn.get(pc)?.get(row.cardId);
                        const columnSize = heatColumnSizes.get(pc) ?? 0;
                        return (
                          <td
                            key={pc}
                            className="px-3 py-1.5 text-right"
                            style={rank === undefined ? undefined : { backgroundColor: heatColorByRank(rank, columnSize, heatPolarity) }}
                            title={cellRow && rank !== undefined ? `${pc}p: rank ${rank}/${columnSize}, ${cellRow.played} placements` : `${pc}p: never played`}
                          >
                            {heatMetricFormat(cellRow, heatMetric)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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

/**
 * Simple hand-rolled bar chart (no charting library), one row per player count that's
 * actually been tallied -- generic over whatever `values` the caller hands it (round
 * length, or a specific card's value metric, see PlayerCountChart below) so both
 * modes render identically instead of looking like two different widgets. A null
 * value (never-tallied at that count) renders as an empty bar and "—", not a gap.
 */
function BarChartByPlayerCount({ title, counts, values }: { title: string; counts: number[]; values: (number | null)[] }) {
  if (counts.length === 0) return null;
  const numericValues = values.filter((v): v is number => v !== null);
  const max = numericValues.length > 0 ? Math.max(...numericValues, 0) : 0;

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <p className="text-sm font-medium">{title}</p>
      <div className="flex flex-col gap-1.5">
        {counts.map((pc, i) => {
          const value = values[i];
          const widthPct = value === null || max <= 0 ? 0 : (Math.max(value, 0) / max) * 100;
          return (
            <div key={pc} className="flex items-center gap-2 text-xs">
              <span className="w-8 shrink-0 text-zinc-500 dark:text-zinc-400">{pc}p</span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded bg-blue-500/70" style={{ width: `${widthPct}%` }} />
              </div>
              <span className="w-10 shrink-0 text-right font-medium">{value === null ? "—" : value.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortableHeader<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onClick,
  align = "left",
  title,
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: 1 | -1;
  onClick: (key: K) => void;
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
