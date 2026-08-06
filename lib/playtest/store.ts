import { CardId } from "@/lib/engine/types";
import { CardStats, createEmptyStats } from "./cardStats";

/**
 * localStorage, not sessionStorage -- unlike multiplayer's per-tab credentials, this
 * is a long-running tally the user deliberately builds up across many simulation runs
 * and real games over time, so it should survive a page reload or a fresh tab, not
 * just persist within one.
 */
const STORAGE_KEY = "board-game:playtest-stats";

export function loadStats(): Record<CardId, CardStats> {
  const stats = createEmptyStats();
  if (typeof window === "undefined") return stats;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return stats;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<CardId, CardStats>>;
    for (const id of Object.keys(stats) as CardId[]) {
      if (parsed[id]) stats[id] = parsed[id]!;
    }
  } catch {
    // Corrupt/foreign value under this key -- fall back to the empty table rather than throwing.
  }
  return stats;
}

export function saveStats(stats: Record<CardId, CardStats>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

export function resetStats(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
