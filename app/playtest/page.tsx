"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { BoardGrid } from "@/app/components/Board";
import { FixedTooltip, LOCATION_COMPLEXITY_ORDER } from "@/app/components/CardCatalog";
import { clearActiveTooltip, setActiveTooltip, toggleActiveTooltip, useActiveTooltipId } from "@/app/hooks/activeTooltip";
import { useHasHover } from "@/app/hooks/useHasHover";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, randomCenterEffectPool, selectableCenterEffects } from "@/lib/content/centerEffects";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { ResolvedCard, resolveBoard } from "@/lib/engine/resolution";
import { AI_DIFFICULTIES, AI_DIFFICULTY_LABELS, DEFAULT_AI_DIFFICULTY } from "@/lib/ai/difficulty";
import { AiDifficulty, CardBucket, CardId, CenterEffectId, GameState } from "@/lib/engine/types";
import {
  CardStatsRow,
  createEmptyStats,
  overallAvgFlipRate,
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

/**
 * Target milliseconds of uninterrupted simulation between UI-thread yields, so a large
 * run stays responsive and cancelable instead of freezing the tab for its whole
 * duration. Time-based rather than a fixed game count: an 8p game is far more
 * expensive to simulate than a 2p one (bigger board, more cards/turns), so a flat
 * "every N games" batch size would yield often enough to stay smooth at low player
 * counts but still visibly stutter at high ones -- measuring elapsed time instead
 * keeps the yield cadence (and so the UI's responsiveness) roughly constant regardless
 * of player count.
 */
const YIELD_INTERVAL_MS = 50;

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

/** sim0/sim1/... (see cardStats.ts's simulateOneGame) -> "P1"/"P2"/... for the live board viewer, which has no real lobby to look names up in. */
function simPlayerLabel(id: string): string {
  const n = Number(id.replace("sim", ""));
  return Number.isNaN(n) ? id : `P${n + 1}`;
}

/**
 * The flat table's own metric columns are exactly the heatmap's "Color by" dropdown
 * options (HEAT_METRIC_LABELS below), in the same order -- rather than a second,
 * independently-maintained column list that can silently drift out of sync with what
 * the heatmap offers (which is how the flat table ended up missing "Value" for a
 * while). Same reasoning for reusing heatMetricValue/heatMetricFormat for every cell
 * instead of one-off per-column formatting.
 */
type SortKey = "name" | "bucket" | HeatMetric;

/**
 * The heatmap's row order is deliberately independent of the flat table's sortKey
 * (see heatmapRows's own doc comment) -- "bucket" is the default bucket-then-name
 * order (no dedicated header of its own, just the starting state), "name" is plain
 * alphabetical (toggled from the heatmap table's own "Card" column header), and any
 * other value is a data column's key (a stringified player count, or a
 * CenterEffectId -- neither ever collides with "bucket"/"name"), toggled by clicking
 * that column's own header to sort by its value for the currently-selected heat
 * metric instead.
 */
type HeatmapSortKey = "bucket" | "name" | (string & {});

function compareNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // never-played cards always sort last, regardless of direction
  if (b === null) return -1;
  return dir * (a - b);
}

type HeatMetric = "placement" | "impact" | "playRate" | "value" | "own" | "final" | "disruption" | "roundLength" | "flipRate";

const HEAT_METRIC_LABELS: Record<HeatMetric, string> = {
  placement: "Placement Δ avg",
  impact: "Impact (strength × play rate)",
  playRate: "Played",
  value: "Value (base + effect)",
  own: "Own Δ base",
  final: "Final score",
  disruption: "Disruption",
  roundLength: "Avg round length",
  flipRate: "Flip rate",
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
    case "flipRate":
      return row.flipRate;
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
    case "flipRate":
      return fmtPercent(row.flipRate);
  }
}

/** Longer explanation for each metric's column header, on both the flat table and the heatmap -- every metric gets one so no column is ever left without a hover explanation. */
const HEAT_METRIC_TITLES: Record<HeatMetric, string> = {
  placement:
    "Average (placement rank - baseline) / (half the game's rank spread), on a fixed -1..+1 scale -- e.g. baseline is 2.5 at 4p, 4.5 at 8p, and the spread-halving keeps a rank-1 finish worth exactly -1 whether it beat 3 opponents or 7. Negative means better than a random seat would average; positive means worse; -1/+1 are the best/worst possible finish, regardless of player count.",
  impact:
    "-Placement Δ avg × play rate -- the unconditional expected placement swing this card contributes across a random game. High and positive means strong AND common (worth a balance look); near 0 means either weak or rare (a rare-but-strong card is 'situational', not broken); negative means common but actively bad (a trap card).",
  playRate:
    "Times placed on the board, as a share of every copy of this card that's existed across every tallied game -- scaled so a card with more printed copies doesn't just look more 'played' for having more copies",
  value:
    "What this card is actually worth to play -- a Control card's own base rarely moves on its own, so its value is base + average damage dealt to an opponent; every other card's value is its own base + conditional effects (avgOwnScore).",
  own: "Base + only this card's own conditional effects (excluding neighbor/center-effect deltas), shown as +/- versus the card's printed base value",
  final: "Full resolved value as actually scored, including neighbor and center effects",
  disruption:
    "Average net damage dealt to a single average opponent, per appearance -- damage to opponents' cards minus damage to this card's own side, divided by opponent count. Always 0 for a card with no outgoing effect on other cards.",
  roundLength: "Average length (in rounds) of games this card appeared in.",
  flipRate:
    "Fraction of this card's appearances that are face-up by game end (flipped by a player, or forceFaceUp -- always known either way). Compare against the board-wide average to see whether this card tends to stay hidden more or less than everything else.",
};

/** Markdown table of the currently-sorted rows, for pasting elsewhere (bug reports, balance discussion) -- same columns (and order) shown on screen, driven off the same HEAT_METRIC_LABELS list as the on-screen table and the heatmap's "Color by" dropdown. */
function buildStatsMarkdown(rows: CardStatsRow[], overallRoundLength: number | null, overallFlipRate: number | null): string {
  const metrics = Object.keys(HEAT_METRIC_LABELS) as HeatMetric[];
  const lines = [
    `Overall average round length: ${fmt(overallRoundLength, 2)}`,
    `Overall average flip rate: ${fmtPercent(overallFlipRate)}`,
    "",
    `| Card | Bucket | ${metrics.map((m) => HEAT_METRIC_LABELS[m]).join(" | ")} |`,
    `|---|---|${metrics.map(() => "---").join("|")}|`,
  ];
  for (const row of rows) {
    const cells = metrics.map((m) => heatMetricFormat(row, m));
    lines.push(`| ${CARD_DEFS[row.cardId].name} | ${CARD_DEFS[row.cardId].bucket} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
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

/**
 * Markdown table of one heatmap metric across a set of columns, for the same "copy"
 * workflow the flat table already has -- generic over the column dimension (player
 * count or location) so buildEverythingMarkdown can reuse this for both instead of
 * duplicating it per dimension the way an earlier version did (which is exactly how
 * the location breakdown ended up missing from the dump in the first place).
 */
function buildHeatmapMarkdown(
  rows: CardStatsRow[],
  columns: { key: string; label: string }[],
  lookup: Map<string, Map<CardId, CardStatsRow>>,
  metric: HeatMetric,
  dimensionLabel: string
): string {
  const lines = [
    `${HEAT_METRIC_LABELS[metric]} by ${dimensionLabel}`,
    "",
    `| Card | ${columns.map((c) => c.label).join(" | ")} |`,
    `|---|${columns.map(() => "---").join("|")}|`,
  ];
  for (const row of rows) {
    const cells = columns.map((c) => heatMetricFormat(lookup.get(c.key)?.get(row.cardId), metric));
    lines.push(`| ${CARD_DEFS[row.cardId].name} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

/**
 * The comprehensive export -- everything on the page in one paste, regardless of
 * which view happens to be showing: the flat all-player-counts table, the average
 * round length/flip rate breakdowns, and every heatmap metric's own table, for BOTH
 * dimensions (player count and location) -- not just whichever one the interactive
 * heatmap happens to be toggled to at the moment (that's what buildHeatmapMarkdown's
 * genericized column param is for: one function, called once per dimension, instead
 * of a second copy that's easy to forget to keep in sync -- see git history for the
 * bug this fixes, where the location breakdown was missing from this dump entirely).
 * Separate from buildStatsMarkdown (the flat table alone) and buildHeatmapMarkdown
 * (one metric, one dimension, alone), which stay available as focused exports.
 */
function buildEverythingMarkdown(
  rows: CardStatsRow[],
  overallRoundLength: number | null,
  overallFlipRate: number | null,
  stats: PlaytestStats,
  heatmapRows: CardStatsRow[],
  availablePlayerCounts: number[],
  heatmapLookup: Map<number, Map<CardId, CardStatsRow>>,
  availableCenterEffects: CenterEffectId[],
  locationLookup: Map<string, Map<CardId, CardStatsRow>>
): string {
  const sections = [buildStatsMarkdown(rows, overallRoundLength, overallFlipRate)];

  if (availablePlayerCounts.length > 0) {
    const roundLengthLines = [
      "Average round length by player count",
      "",
      "| Player count | Avg round length |",
      "|---|---|",
      ...availablePlayerCounts.map((pc) => `| ${pc}p | ${fmt(overallAvgRoundLength(stats.byPlayerCount[pc]), 2)} |`),
    ];
    sections.push(roundLengthLines.join("\n") + "\n");

    const flipRateLines = [
      "Average flip rate by player count",
      "",
      "| Player count | Avg flip rate |",
      "|---|---|",
      ...availablePlayerCounts.map((pc) => `| ${pc}p | ${fmtPercent(overallAvgFlipRate(stats.byPlayerCount[pc]))} |`),
    ];
    sections.push(flipRateLines.join("\n") + "\n");

    const playerCountColumns = availablePlayerCounts.map((pc) => ({ key: String(pc), label: `${pc}p` }));
    const playerCountLookup = new Map([...heatmapLookup.entries()].map(([pc, lookup]) => [String(pc), lookup] as const));
    for (const metric of Object.keys(HEAT_METRIC_LABELS) as HeatMetric[]) {
      sections.push(buildHeatmapMarkdown(heatmapRows, playerCountColumns, playerCountLookup, metric, "player count"));
    }
  }

  if (availableCenterEffects.length > 0) {
    const roundLengthLines = [
      "Average round length by location",
      "",
      "| Location | Avg round length |",
      "|---|---|",
      ...availableCenterEffects.map((id) => `| ${CENTER_EFFECTS[id].label} | ${fmt(overallAvgRoundLength(stats.byCenterEffect[id]), 2)} |`),
    ];
    sections.push(roundLengthLines.join("\n") + "\n");

    const flipRateLines = [
      "Average flip rate by location",
      "",
      "| Location | Avg flip rate |",
      "|---|---|",
      ...availableCenterEffects.map((id) => `| ${CENTER_EFFECTS[id].label} | ${fmtPercent(overallAvgFlipRate(stats.byCenterEffect[id]))} |`),
    ];
    sections.push(flipRateLines.join("\n") + "\n");

    const locationColumns = availableCenterEffects.map((id) => ({ key: id, label: CENTER_EFFECTS[id].label }));
    for (const metric of Object.keys(HEAT_METRIC_LABELS) as HeatMetric[]) {
      sections.push(buildHeatmapMarkdown(heatmapRows, locationColumns, locationLookup, metric, "location"));
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
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(DEFAULT_AI_DIFFICULTY);
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
  // Independent of heatmapSortKey/heatmapSortDir (which reorder ROWS by one column's
  // value) -- this reorders COLUMNS by one ROW's values instead, so clicking a card
  // answers "which location/player-count is best *for this card specifically*"
  // instead of "which card is best at this location". Click the same card again to
  // clear it back to the default column order.
  const [columnSortCardId, setColumnSortCardId] = useState<CardId | null>(null);
  const [chartMode, setChartMode] = useState<"roundLength" | "cardValue" | "flipRate">("roundLength");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [copyTableFeedback, setCopyTableFeedback] = useState(false);
  const [view, setView] = useState<"table" | "heatmap">("table");
  const [heatMetric, setHeatMetric] = useState<HeatMetric>("placement");
  const [heatmapDimension, setHeatmapDimension] = useState<"playerCount" | "location">("playerCount");
  // Checked once per batch, not once per game -- cancel doesn't need to be instant,
  // just prompt (finishing the in-flight batch, at most ~YIELD_INTERVAL_MS of work, is fine).
  const cancelRef = useRef(false);
  // Ref (not state) re-entrancy guard for runSimulation -- a second click that lands
  // before React has had a chance to paint the disabled "Run simulation" button (see
  // runSimulation's own comment) would otherwise still see stale `running` state from
  // the same render and start a second, overlapping run.
  const runInProgressRef = useRef(false);

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
    tallyGame(working, result.cards, finalState.result!.scores, finalState.config.playerCount, finalState.round, finalState.config.centerEffect);
  }

  /** `startFresh` clears any already-tallied data before this run instead of adding to it -- see the pre-run confirmation popup below, which is the only place that ever passes true. */
  async function runSimulation(startFresh: boolean) {
    if (runInProgressRef.current) return;
    runInProgressRef.current = true;
    setRunning(true);
    setProgress(0);
    setLiveState(null);
    cancelRef.current = false;
    // Yield once, immediately, before touching the (potentially expensive) simulation
    // loop below -- without this, everything up to the loop's first yield runs as one
    // uninterrupted synchronous stretch of JS, so the browser never gets a chance to
    // actually paint the "running" state (disabled inputs, progress bar) until after
    // that first stretch finishes. At 8p that first stretch used to be long enough
    // that the button/confirmation popup appeared to just not have responded at all,
    // inviting extra clicks -- runInProgressRef above stops those from starting a
    // second overlapping run, and this yield makes sure the UI actually shows it's
    // working right away instead of looking frozen.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A working copy, mutated in place by tallyGame across the whole run for speed --
    // committed to React state (and localStorage) once per batch, not once per game,
    // so a few-thousand-game run doesn't trigger a few thousand re-renders.
    const working = startFresh ? createEmptyStats() : loadStats();

    const playerCounts = runAllPlayerCounts ? ALL_PLAYER_COUNTS : [playerCount];
    const totalGames = gameCount * playerCounts.length;
    let completed = 0;
    let lastYieldAt = performance.now();

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
          const steps = simulateOneGameSteps(pc, effect, Math.random, aiDifficulty);
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
          finalState = simulateOneGame(pc, effect, Math.random, aiDifficulty);
        }

        tallyOneGame(working, finalState);
        completed++;

        if (completed === totalGames || performance.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
          setProgress(completed);
          setStats({ ...working });
          saveStats(working);
          if (cancelRef.current) break runLoop;
          // Yields to the browser between batches so the tab stays responsive/paintable
          // -- redundant with the per-action yield above when watchLive is on, but
          // still needed for the fast (non-watching) path.
          if (!watchLive) await new Promise((resolve) => setTimeout(resolve, 0));
          lastYieldAt = performance.now();
        }
      }
    }

    setRunning(false);
    runInProgressRef.current = false;
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
    if (sortKey === "name") return sortDir * CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name);
    if (sortKey === "bucket") return sortDir * byBucketThenName(a, b);
    return compareNullable(heatMetricValue(a, sortKey), heatMetricValue(b, sortKey), sortDir);
  });
  const totalPlayed = rows.reduce((sum, r) => sum + r.played, 0);
  const overallRoundLength = overallAvgRoundLength(stats);
  const overallFlipRate = overallAvgFlipRate(stats);
  const totalGamesConfigured = gameCount * (runAllPlayerCounts ? ALL_PLAYER_COUNTS.length : 1);

  // Heatmap data -- every available player count's own StatsBucket, summarized and
  // indexed by cardId. The row order is independent of the flat table's own sort (the
  // heatmap's whole point is comparing across columns, so its rows shouldn't shuffle
  // just because you sorted the flat table by a different column) -- default
  // bucket-then-name, plain alphabetical, or sorted by one specific column's value for
  // the current heat metric, all via the heatmap table's own column headers (see
  // HeatmapSortKey/toggleHeatmapSort), independently of the flat table's sort.
  const availablePlayerCounts = Object.keys(stats.byPlayerCount)
    .map(Number)
    .sort((a, b) => a - b);
  const heatmapLookup = new Map<number, Map<CardId, CardStatsRow>>(
    availablePlayerCounts.map((pc) => [pc, new Map(statsSummary(stats.byPlayerCount[pc] as StatsBucket).map((r) => [r.cardId, r]))])
  );

  // The interactive heatmap table's own columns -- either the same per-player-count
  // slices as above, or a per-location ("center effect") slice, toggled by
  // heatmapDimension. Both are just StatsBucket, so this reuses statsSummary the same
  // way; the column key is a string either way (a stringified player count, or a
  // CenterEffectId) so one set of rank/size maps below covers both dimensions. Location
  // columns are ordered the same way the catalog's Locations sidebar is (see
  // LOCATION_COMPLEXITY_ORDER), not insertion/tally order.
  const availableCenterEffects = LOCATION_COMPLEXITY_ORDER.filter((id) => (stats.byCenterEffect[id]?.overall.gamesTallied ?? 0) > 0);
  // Computed unconditionally (not gated by heatmapDimension) -- copyEverything needs
  // both dimensions' data regardless of which one the interactive heatmap currently
  // happens to be toggled to (see buildEverythingMarkdown's doc comment for the bug
  // this fixes).
  const locationLookup = new Map<string, Map<CardId, CardStatsRow>>(
    availableCenterEffects.map((id) => [id, new Map(statsSummary(stats.byCenterEffect[id]).map((r) => [r.cardId, r]))])
  );
  const heatmapColumns: { key: string; label: string; title: string }[] =
    heatmapDimension === "playerCount"
      ? availablePlayerCounts.map((pc) => ({ key: String(pc), label: `${pc}p`, title: `${pc} players` }))
      : availableCenterEffects.map((id) => ({ key: id, label: CENTER_EFFECTS[id].label, title: CENTER_EFFECTS[id].label }));
  const heatmapColumnLookup =
    heatmapDimension === "playerCount"
      ? new Map<string, Map<CardId, CardStatsRow>>([...heatmapLookup.entries()].map(([pc, lookup]) => [String(pc), lookup]))
      : locationLookup;
  const heatmapColumnKeys = new Set(heatmapColumns.map((c) => c.key));
  // When a card is pinned (see columnSortCardId), reorder columns by THAT card's own
  // value in each one -- "best for this card first", respecting the metric's polarity
  // (placement: lower/more-negative is better, so ascending; every other metric:
  // higher is more notable, so descending) -- same polarity heatColorByRank already
  // uses for coloring, just applied to column order instead of column color. Falls
  // back to the plain default column order (playerCount/complexity order) when
  // nothing's pinned.
  const orderedHeatmapColumns =
    columnSortCardId === null
      ? heatmapColumns
      : [...heatmapColumns].sort((a, b) => {
          const va = heatMetricValue(heatmapColumnLookup.get(a.key)?.get(columnSortCardId), heatMetric);
          const vb = heatMetricValue(heatmapColumnLookup.get(b.key)?.get(columnSortCardId), heatMetric);
          return compareNullable(va, vb, heatMetricPolarity(heatMetric) === "lowIsGood" ? 1 : -1);
        });
  const heatmapRows = [...rows].sort((a, b) => {
    if (heatmapSortKey !== "bucket" && heatmapSortKey !== "name" && heatmapColumnKeys.has(heatmapSortKey)) {
      const colLookup = heatmapColumnLookup.get(heatmapSortKey);
      return compareNullable(heatMetricValue(colLookup?.get(a.cardId), heatMetric), heatMetricValue(colLookup?.get(b.cardId), heatMetric), heatmapSortDir);
    }
    return heatmapSortKey === "name" ? heatmapSortDir * CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name) : heatmapSortDir * byBucketThenName(a, b);
  });
  const heatPolarity = heatMetricPolarity(heatMetric);
  // Rank (1 = lowest value) of every card within its own column, for the selected
  // metric -- see heatColorByRank's doc comment for why coloring is relative to the
  // column, not one shared scale across every column.
  const heatRanksByColumn = new Map<string, Map<CardId, number>>();
  const heatColumnSizes = new Map<string, number>();
  for (const column of heatmapColumns) {
    const colLookup = heatmapColumnLookup.get(column.key)!;
    const ranked = heatmapRows
      .map((row) => ({ cardId: row.cardId, value: heatMetricValue(colLookup.get(row.cardId), heatMetric) }))
      .filter((e): e is { cardId: CardId; value: number } => e.value !== null)
      .sort((a, b) => a.value - b.value);
    heatRanksByColumn.set(
      column.key,
      new Map(ranked.map((e, i) => [e.cardId, i + 1]))
    );
    heatColumnSizes.set(column.key, ranked.length);
  }

  /** The top button -- everything on the page, regardless of which view is active. */
  function copyEverything() {
    const text = buildEverythingMarkdown(
      rows,
      overallRoundLength,
      overallFlipRate,
      stats,
      heatmapRows,
      availablePlayerCounts,
      heatmapLookup,
      availableCenterEffects,
      locationLookup
    );
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    });
  }

  /** The button next to the flat table -- just that table, not the heatmap/round-length breakdowns too. */
  function copyTable() {
    navigator.clipboard.writeText(buildStatsMarkdown(rows, overallRoundLength, overallFlipRate)).then(() => {
      setCopyTableFeedback(true);
      setTimeout(() => setCopyTableFeedback(false), 1500);
    });
  }

  function onSelfGameEnded(cards: ResolvedCard[], scores: Record<string, number>, roundsPlayed: number, resolvedCenterEffect: CenterEffectId) {
    const working = loadStats();
    tallyGame(working, cards, scores, playerCount, roundsPlayed, resolvedCenterEffect);
    saveStats(working);
    setStats(working);
    setSelfPlayedCount((n) => n + 1);
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-4 py-8">
      <header className="flex w-full max-w-4xl flex-col gap-2">
        <div className="flex w-full items-center justify-between gap-2">
          <h1 className="text-lg font-semibold sm:text-xl">
            Betrayer&apos;s Ball <span className="font-normal text-zinc-500">— playtest stats</span>
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
          <label htmlFor="pt-difficulty">Difficulty</label>
          <select
            id="pt-difficulty"
            value={aiDifficulty}
            disabled={running}
            onChange={(e) => setAiDifficulty(e.target.value as AiDifficulty)}
            className="w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
          >
            {AI_DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {AI_DIFFICULTY_LABELS[d]}
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
            onCellClick={() => {}}
            onCellDragOver={() => {}}
            onCellDragLeave={() => {}}
            onCellDrop={() => {}}
          />
        </div>
      )}

      <div className="flex w-full max-w-4xl flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-zinc-500">
          {totalPlayed === 0
            ? "No games tallied yet."
            : `${totalPlayed.toLocaleString()} card placements across ${stats.overall.gamesTallied.toLocaleString()} games so far -- averaging ${fmt(overallRoundLength, 2)} rounds/game.`}
        </p>
        {confirmingReset ? (
          <div className="flex w-full flex-wrap items-center gap-2 text-xs sm:w-auto">
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
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
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
                <SortableHeader
                  label="Card"
                  sortKey="name"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  tooltip="Card name -- click to sort alphabetically."
                  tooltipId="playtest-flat:name"
                />
                <SortableHeader
                  label="Bucket"
                  sortKey="bucket"
                  activeKey={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  tooltip="Slam / Engine / Control -- click to sort by bucket, then by name within it."
                  tooltipId="playtest-flat:bucket"
                />
                {(Object.keys(HEAT_METRIC_LABELS) as HeatMetric[]).map((m) => (
                  <SortableHeader
                    key={m}
                    label={HEAT_METRIC_LABELS[m]}
                    sortKey={m}
                    activeKey={sortKey}
                    dir={sortDir}
                    onClick={toggleSort}
                    align="right"
                    tooltip={
                      m === "roundLength"
                        ? `${HEAT_METRIC_TITLES[m]} Overall average across every tallied game: ${fmt(overallRoundLength, 2)}`
                        : m === "flipRate"
                          ? `${HEAT_METRIC_TITLES[m]} Overall average across every tallied game: ${fmtPercent(overallFlipRate)}`
                          : HEAT_METRIC_TITLES[m]
                    }
                    tooltipId={`playtest-flat:${m}`}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: CardStatsRow) => (
                <tr key={row.cardId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-3 py-1.5 font-medium">{CARD_DEFS[row.cardId].name}</td>
                  <td className="px-3 py-1.5 text-zinc-500 dark:text-zinc-400">{CARD_DEFS[row.cardId].bucket}</td>
                  {(Object.keys(HEAT_METRIC_LABELS) as HeatMetric[]).map((m) => (
                    <td
                      key={m}
                      className="px-3 py-1.5 text-right"
                      title={m === "playRate" ? `${row.played} / ${row.copiesInDeck} copies` : undefined}
                    >
                      {heatMetricFormat(row, m)}
                    </td>
                  ))}
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
            <button
              onClick={() => setChartMode("flipRate")}
              className={`px-3 py-1 whitespace-nowrap ${chartMode === "flipRate" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
            >
              Flip rate
            </button>
          </div>
          {chartMode === "roundLength" ? (
            <BarChartByPlayerCount
              title="Average round length by player count"
              counts={availablePlayerCounts}
              values={availablePlayerCounts.map((pc) => overallAvgRoundLength(stats.byPlayerCount[pc]))}
            />
          ) : chartMode === "cardValue" ? (
            <BarChartByPlayerCount
              title="Average card value by player count"
              counts={availablePlayerCounts}
              values={availablePlayerCounts.map((pc) => averageCardValueAt(heatmapLookup.get(pc)))}
            />
          ) : (
            <BarChartByPlayerCount
              title="Average flip rate by player count -- fraction of the board face-up at game end"
              counts={availablePlayerCounts}
              values={availablePlayerCounts.map((pc) => overallAvgFlipRate(stats.byPlayerCount[pc]))}
              format={fmtPercent}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
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
            <div className="flex self-start overflow-hidden rounded-full border border-zinc-300 text-xs dark:border-zinc-700">
              <button
                onClick={() => setHeatmapDimension("playerCount")}
                className={`px-3 py-1 whitespace-nowrap ${heatmapDimension === "playerCount" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
              >
                By player count
              </button>
              <button
                onClick={() => setHeatmapDimension("location")}
                className={`px-3 py-1 whitespace-nowrap ${heatmapDimension === "location" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
              >
                By location
              </button>
            </div>
          </div>
          {heatmapColumns.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {heatmapDimension === "playerCount" ? "Run a simulation to see the heatmap." : "Run a simulation (any location, including \"Random\") to see the heatmap."}
            </p>
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
                      tooltip="Sort alphabetically -- click again to reverse. Doesn't affect the flat table's own sort."
                      tooltipId="playtest-heat:name"
                    />
                    {orderedHeatmapColumns.map((column) => (
                      <SortableHeader
                        key={column.key}
                        label={column.label}
                        sortKey={column.key}
                        activeKey={heatmapSortKey}
                        dir={heatmapSortDir}
                        onClick={toggleHeatmapSort}
                        align="right"
                        tooltip={`${column.title} -- click to sort by this column's value for the current heat metric, click again to reverse.`}
                        tooltipId={`playtest-heat:${column.key}`}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatmapRows.map((row) => (
                    <tr key={row.cardId} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                      <td
                        className={`px-3 py-1.5 font-medium whitespace-nowrap cursor-pointer select-none ${
                          columnSortCardId === row.cardId ? "text-emerald-700 dark:text-emerald-400" : "hover:underline"
                        }`}
                        title={
                          columnSortCardId === row.cardId
                            ? "Columns are sorted best-for-this-card-first -- click again to reset to the default column order."
                            : "Click to sort columns by this card's own values (best-for-this-card first) instead of the default order."
                        }
                        onClick={() => setColumnSortCardId((current) => (current === row.cardId ? null : row.cardId))}
                      >
                        {CARD_DEFS[row.cardId].name}
                      </td>
                      {orderedHeatmapColumns.map((column) => {
                        const cellRow = heatmapColumnLookup.get(column.key)?.get(row.cardId);
                        const rank = heatRanksByColumn.get(column.key)?.get(row.cardId);
                        const columnSize = heatColumnSizes.get(column.key) ?? 0;
                        return (
                          <td
                            key={column.key}
                            className="px-3 py-1.5 text-right"
                            style={rank === undefined ? undefined : { backgroundColor: heatColorByRank(rank, columnSize, heatPolarity) }}
                            title={
                              cellRow && rank !== undefined
                                ? `${column.label}: rank ${rank}/${columnSize}, ${cellRow.played} placements`
                                : `${column.label}: never played`
                            }
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
        <PlaySelf playerCount={playerCount} centerEffect={centerEffect} aiDifficulty={aiDifficulty} onGameEnded={onSelfGameEnded} />
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
function BarChartByPlayerCount({
  title,
  counts,
  values,
  format = (n) => n!.toFixed(2),
}: {
  title: string;
  counts: number[];
  values: (number | null)[];
  /** How to render each bar's own label -- defaults to 2-decimal fixed, but a 0..1-ranged metric (e.g. flip rate) wants a percent instead. Never called with null (the caller already handles that case separately). */
  format?: (n: number | null) => string;
}) {
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
              <span className="w-10 shrink-0 text-right font-medium">{value === null ? "—" : format(value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Native `title` attributes (the old approach here) never show on touch -- most mobile
 * browsers have no hover/long-press affordance for them at all, so every column
 * description was silently invisible on a phone. Same fix as CardCatalog's bucket
 * headers: hover-capable devices get the description on hovering the whole header;
 * touch devices get it via a small tappable "i" that's separate from the header
 * button itself, so tapping the header to sort and tapping the "i" to read the
 * description don't fight over the same tap. `tooltipId` must be globally unique
 * (this component is reused by both the flat table and the heatmap table, whose
 * sortKey values can otherwise collide) -- see activeTooltip.ts.
 */
function SortableHeader<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onClick,
  align = "left",
  tooltip,
  tooltipId,
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: 1 | -1;
  onClick: (key: K) => void;
  align?: "left" | "right";
  tooltip?: string;
  tooltipId?: string;
}) {
  const active = sortKey === activeKey;
  const hasHover = useHasHover();
  const activeTooltipId = useActiveTooltipId();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const showInfo = tooltip !== undefined && tooltipId !== undefined;

  return (
    <th className={`relative px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <span
        className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}
        onMouseEnter={
          showInfo && hasHover
            ? (e) => {
                setRect(e.currentTarget.getBoundingClientRect());
                setActiveTooltip(tooltipId);
              }
            : undefined
        }
        onMouseLeave={showInfo && hasHover ? () => clearActiveTooltip(tooltipId) : undefined}
      >
        <button
          onClick={() => onClick(sortKey)}
          className={`inline-flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-200 ${active ? "text-zinc-700 dark:text-zinc-200" : ""}`}
        >
          {label}
          <span className="w-2.5 text-[9px]">{active ? (dir === 1 ? "▲" : "▼") : ""}</span>
        </button>
        {showInfo && !hasHover && (
          <span
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-zinc-400 text-[9px] normal-case text-zinc-400 dark:border-zinc-500 dark:text-zinc-500"
            onClick={(e) => {
              e.stopPropagation();
              setRect(e.currentTarget.getBoundingClientRect());
              toggleActiveTooltip(tooltipId);
            }}
          >
            i
          </span>
        )}
      </span>
      {showInfo && activeTooltipId === tooltipId && rect && <FixedTooltip rect={rect} placement="below">{tooltip}</FixedTooltip>}
    </th>
  );
}
