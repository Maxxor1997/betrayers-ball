import { CardId } from "@/lib/engine/types";
import { createEmptyBucket, createEmptyStats, placementBaseline, PlaytestStats, StatsBucket } from "./cardStats";

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
 *
 * `playerCount`, when known (a per-player-count slice, not the blended total -- see
 * PlaytestStats.byPlayerCount), lets a missing `placementDeltaSum` be *exactly*
 * reconstructed from `placementSum`/`played` instead of defaulting to 0: every game in
 * a single-player-count bucket shares the same baseline, so
 * `sum(rank - baseline) == sum(rank) - played*baseline == placementSum -
 * played*baseline`. Defaulting to 0 there wouldn't just be imprecise, it would be
 * actively wrong -- it silently claims "exactly average" for every already-played
 * game, which is how "shows 0 for everything" happened the first time this kind of
 * field was added.
 */
function mergeBucket(parsed: unknown, playerCount?: number): StatsBucket {
  const bucket = createEmptyBucket();
  if (!parsed || typeof parsed !== "object" || !("cards" in parsed) || !("overall" in parsed)) return bucket;
  const p = parsed as { cards: Record<string, unknown>; overall: unknown };
  for (const id of Object.keys(bucket.cards) as CardId[]) {
    const rawCard = p.cards[id];
    if (!rawCard || typeof rawCard !== "object") continue;
    bucket.cards[id] = { ...bucket.cards[id], ...rawCard };
    if (playerCount !== undefined && !("placementDeltaSum" in rawCard)) {
      const entry = bucket.cards[id];
      entry.placementDeltaSum = entry.placementSum - entry.played * placementBaseline(playerCount);
    }
  }
  if (p.overall && typeof p.overall === "object") bucket.overall = { ...bucket.overall, ...p.overall };
  return bucket;
}

function mergeStats(parsed: unknown): PlaytestStats {
  const stats: PlaytestStats = { ...createEmptyBucket(), byPlayerCount: {} };
  if (!parsed || typeof parsed !== "object") return stats;

  const hasTopShape = "cards" in parsed && "overall" in parsed;
  const topRawCards = hasTopShape ? (parsed as { cards: Record<string, unknown> }).cards : undefined;

  // Per-player-count slices first -- each one's own known player count is what makes
  // an exact placementDeltaSum reconstruction possible (see mergeBucket).
  const p = parsed as { byPlayerCount?: unknown };
  if (p.byPlayerCount && typeof p.byPlayerCount === "object") {
    for (const [key, value] of Object.entries(p.byPlayerCount as Record<string, unknown>)) {
      const playerCount = Number(key);
      if (!Number.isFinite(playerCount)) continue;
      stats.byPlayerCount[playerCount] = mergeBucket(value, playerCount);
    }
  }

  const top = mergeBucket(hasTopShape ? parsed : undefined);
  stats.cards = top.cards;
  stats.overall = top.overall;

  // The blended (all-player-counts) total can't recompute its own placementDeltaSum
  // from placementSum/played the way a single-count slice can (it mixes different
  // baselines) -- but it's still exactly recoverable by summing the per-player-count
  // slices just rebuilt above, as long as those exist (true for any data saved after
  // the per-player-count breakdown shipped, which is everything that has this problem).
  for (const id of Object.keys(stats.cards) as CardId[]) {
    const rawCard = topRawCards?.[id];
    if (rawCard && typeof rawCard === "object" && !("placementDeltaSum" in rawCard)) {
      let sum = 0;
      for (const bucket of Object.values(stats.byPlayerCount)) sum += bucket.cards[id].placementDeltaSum;
      stats.cards[id].placementDeltaSum = sum;
    }
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
