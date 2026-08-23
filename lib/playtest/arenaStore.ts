import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";
import {
  ArenaBucketStats,
  ArenaSeatBuckets,
  ArenaSeatConfig,
  ArenaStats,
  createEmptyArenaStats,
  createEmptyFixedSeatArenaStats,
  defaultArenaSeatConfig,
  normalizeArenaBucket,
} from "./aiArena";

/**
 * localStorage, not sessionStorage -- same reasoning as the main playtest page's own
 * store.ts: a batch's results (and the config that produced them) are a deliberate
 * tally the user builds up across several runs while A/B testing, not per-tab scratch
 * state. This page started out deliberately ephemeral (reset on reload, see its own
 * former header comment), but that made it unusable for exactly the kind of
 * back-to-back comparison it exists for -- losing 500 games' worth of results to an
 * accidental refresh.
 */
const STORAGE_KEY = "board-game:arena-state";

export type PersistedArenaMode = "shuffle" | "fixed";

export interface PersistedArenaState {
  mode: PersistedArenaMode;
  playerCount: number;
  centerEffect: CenterEffectId | "random";
  selectedDifficulties: AiDifficulty[];
  gameCount: number;
  hardBudgetMs: number;
  stats: ArenaStats;
  seatConfigs: ArenaSeatConfig[];
  seatBuckets: ArenaSeatBuckets;
}

function defaultArenaState(): PersistedArenaState {
  const playerCount = 4;
  return {
    mode: "shuffle",
    playerCount,
    centerEffect: "random",
    selectedDifficulties: ["easy", "medium"],
    gameCount: 500,
    hardBudgetMs: 75,
    stats: createEmptyArenaStats(),
    seatConfigs: Array.from({ length: playerCount }, defaultArenaSeatConfig),
    seatBuckets: createEmptyFixedSeatArenaStats(playerCount),
  };
}

/**
 * Shallow-merges a parsed blob onto a fresh default for the top-level fields (mode,
 * playerCount, ...) -- a field absent there just falls back to its safe default
 * instead of coming back `undefined`. `stats`/`seatBuckets` need their own pass
 * though: the shallow merge takes whichever nested bucket blob was persisted
 * wholesale, so a bucket saved before a field (e.g. votesCast/votesYes) existed keeps
 * that field `undefined` rather than 0 -- see normalizeArenaBucket, which fills any
 * such gap back in so summarizeBucket's division never lands on `undefined /
 * undefined` (NaN) where it means "no data yet" (null).
 */
export function loadArenaState(): PersistedArenaState {
  const fallback = defaultArenaState();
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const merged: PersistedArenaState = { ...fallback, ...parsed };
    return { ...merged, stats: normalizeStats(merged.stats), seatBuckets: normalizeSeatBuckets(merged.seatBuckets) };
  } catch {
    return fallback;
  }
}

function normalizeStats(stats: ArenaStats): ArenaStats {
  const byDifficulty = { ...stats.byDifficulty };
  for (const difficulty of Object.keys(byDifficulty) as AiDifficulty[]) {
    byDifficulty[difficulty] = normalizeArenaBucket(byDifficulty[difficulty]);
  }
  const byPosition: Record<number, ArenaBucketStats> = {};
  for (const [position, bucket] of Object.entries(stats.byPosition ?? {})) {
    byPosition[Number(position)] = normalizeArenaBucket(bucket);
  }
  return { byDifficulty, byPosition };
}

function normalizeSeatBuckets(seatBuckets: ArenaSeatBuckets): ArenaSeatBuckets {
  if (!Array.isArray(seatBuckets)) return [];
  return seatBuckets.map(normalizeArenaBucket);
}

export function saveArenaState(state: PersistedArenaState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetArenaState(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
