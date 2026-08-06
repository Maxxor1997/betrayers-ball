import { CardId } from "@/lib/engine/types";
import { createEmptyBucket, createEmptyStats, PlaytestStats, StatsBucket } from "./cardStats";

/**
 * localStorage, not sessionStorage -- unlike multiplayer's per-tab credentials, this
 * is a long-running tally the user deliberately builds up across many simulation runs
 * and real games over time, so it should survive a page reload or a fresh tab, not
 * just persist within one.
 */
const STORAGE_KEY = "board-game:playtest-stats";

/**
 * Merges `parsed` onto a freshly-zeroed StatsBucket field-by-field (not a blind
 * `bucket.cards[id] = parsed.cards[id]`) -- a stored blob from before a field existed
 * (e.g. copiesInDeck/roundLengthSum were both added after this feature first shipped)
 * simply never serialized that key at all, so replacing the whole entry would leave it
 * `undefined` and every average built from it would silently become NaN (this is what
 * was actually behind "stats dividing by 0": NaN isn't caught by a `=== 0` guard).
 * Spreading the zeroed default first means any field genuinely absent from `parsed`
 * keeps its safe zero instead.
 */
function mergeBucket(parsed: unknown): StatsBucket {
  const bucket = createEmptyBucket();
  if (!parsed || typeof parsed !== "object" || !("cards" in parsed) || !("overall" in parsed)) return bucket;
  const p = parsed as { cards: Record<string, unknown>; overall: unknown };
  for (const id of Object.keys(bucket.cards) as CardId[]) {
    if (p.cards[id]) bucket.cards[id] = { ...bucket.cards[id], ...p.cards[id] };
  }
  if (p.overall && typeof p.overall === "object") bucket.overall = { ...bucket.overall, ...p.overall };
  return bucket;
}

function mergeStats(parsed: unknown): PlaytestStats {
  const top = mergeBucket(parsed);
  const stats: PlaytestStats = { ...top, byPlayerCount: {} };

  if (!parsed || typeof parsed !== "object") return stats;
  const p = parsed as { byPlayerCount?: unknown };
  if (!p.byPlayerCount || typeof p.byPlayerCount !== "object") return stats;

  for (const [key, value] of Object.entries(p.byPlayerCount as Record<string, unknown>)) {
    const playerCount = Number(key);
    if (!Number.isFinite(playerCount)) continue;
    stats.byPlayerCount[playerCount] = mergeBucket(value);
  }
  return stats;
}

export function loadStats(): PlaytestStats {
  if (typeof window === "undefined") return createEmptyStats();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return createEmptyStats();
  try {
    return mergeStats(JSON.parse(raw));
  } catch {
    // Corrupt/foreign value under this key -- fall back to the empty table rather than throwing.
    return createEmptyStats();
  }
}

export function saveStats(stats: PlaytestStats): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

export function resetStats(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
