import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";
import {
  ArenaSeatBuckets,
  ArenaSeatConfig,
  ArenaStats,
  createEmptyArenaStats,
  createEmptyFixedSeatArenaStats,
  defaultArenaSeatConfig,
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
 * Shallow-merges a parsed blob onto a fresh default -- no per-field migration math
 * like the main playtest store needs (nothing here is a derived/summed value that a
 * missing field would silently corrupt), so a field absent from an older saved shape
 * just falls back to its safe default instead of coming back `undefined`.
 */
export function loadArenaState(): PersistedArenaState {
  const fallback = defaultArenaState();
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export function saveArenaState(state: PersistedArenaState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetArenaState(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
