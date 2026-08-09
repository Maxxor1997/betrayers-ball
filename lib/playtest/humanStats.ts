import { ResolvedCard } from "@/lib/engine/resolution";
import { CenterEffectId } from "@/lib/engine/types";
import { computeRanks, placementBaseline, PlaytestStats, tallyGame } from "./cardStats";
import { loadStats, mergeStats, resetStats, saveStats } from "./store";

/**
 * Personal single-player tracking -- distinct from the playtest page's bulk
 * AI-vs-AI simulation data (lib/playtest/store.ts's default key), even though the
 * per-card slice below reuses that exact same PlaytestStats shape/tallyGame logic.
 * These live under their own localStorage keys so a human's own track record never
 * gets blended into (or wiped by) the AI balance-testing table, and vice versa.
 */
const CARD_STORAGE_KEY = "board-game:human-card-stats";
const PLACEMENT_STORAGE_KEY = "board-game:human-placement-stats";

/** One "slice" of the human's own finishing-placement history -- everything, or scoped to one player count/location (see HumanPlacementStats). */
export interface OwnPlacementBucket {
  gamesPlayed: number;
  /**
   * Sum of (rank - placementBaseline(that game's playerCount)) across every game in
   * this slice -- see avgPlacementDelta. A raw average rank isn't meaningful once a
   * slice spans a mix of player counts (1st of 2 and 1st of 8 aren't the same
   * accomplishment, and "by location" in particular can span every player count you've
   * ever played that location at), so each game's contribution is measured against its
   * own game's baseline before being summed, the same way CardStats.placementDeltaSum
   * works in cardStats.ts.
   */
  placementDeltaSum: number;
}

function createEmptyPlacementBucket(): OwnPlacementBucket {
  return { gamesPlayed: 0, placementDeltaSum: 0 };
}

/** The human's own placement history, blended and split out per player count (a 1st-place finish in a 2p game and a 1st-place finish in an 8p game aren't the same accomplishment, so keep both the blend and the breakdown) and per location. */
export interface HumanPlacementStats {
  overall: OwnPlacementBucket;
  byPlayerCount: Record<number, OwnPlacementBucket>;
  byCenterEffect: Record<CenterEffectId, OwnPlacementBucket>;
}

export function createEmptyHumanPlacementStats(): HumanPlacementStats {
  return { overall: createEmptyPlacementBucket(), byPlayerCount: {}, byCenterEffect: {} as Record<CenterEffectId, OwnPlacementBucket> };
}

function tallyPlacementBucket(bucket: OwnPlacementBucket, rank: number, playerCount: number): void {
  bucket.gamesPlayed += 1;
  bucket.placementDeltaSum += rank - placementBaseline(playerCount);
}

/** Average (rank - baseline) across a slice -- negative means you tend to place better than a random seat would, positive means worse, 0 is exactly average. Null (not 0) if the slice has no games yet. Meaningful to compare across slices even when they mix player counts, unlike a raw average rank. */
export function avgPlacementDelta(bucket: OwnPlacementBucket): number | null {
  return bucket.gamesPlayed === 0 ? null : bucket.placementDeltaSum / bucket.gamesPlayed;
}

/**
 * Folds one finished single-player game into both the human's own per-card stats
 * (`cardStats`, the same PlaytestStats/tallyGame machinery the playtest page's bulk
 * sims use -- see lib/playtest/cardStats.ts) and their own placement history
 * (`placementStats`). Scoped to just the human's own performance: `resolvedCards` is
 * filtered down to cards `humanId` actually owns before handing it to tallyGame, so an
 * AI opponent's cards never pollute "how do cards do when *I* play them" -- rank is
 * still computed off the full `scores` map, since that's necessarily about every
 * seat's total, not just the human's own cards.
 */
export function tallyHumanGame(
  cardStats: PlaytestStats,
  placementStats: HumanPlacementStats,
  resolvedCards: ResolvedCard[],
  scores: Record<string, number>,
  playerCount: number,
  roundsPlayed: number,
  centerEffect: CenterEffectId,
  humanId: string
): void {
  const rank = computeRanks(scores).get(humanId)!;
  tallyPlacementBucket(placementStats.overall, rank, playerCount);
  if (!placementStats.byPlayerCount[playerCount]) placementStats.byPlayerCount[playerCount] = createEmptyPlacementBucket();
  tallyPlacementBucket(placementStats.byPlayerCount[playerCount], rank, playerCount);
  if (!placementStats.byCenterEffect[centerEffect]) placementStats.byCenterEffect[centerEffect] = createEmptyPlacementBucket();
  tallyPlacementBucket(placementStats.byCenterEffect[centerEffect], rank, playerCount);

  const ownCards = resolvedCards.filter((c) => c.ownerId === humanId);
  tallyGame(cardStats, ownCards, scores, playerCount, roundsPlayed, centerEffect);
}

export function loadHumanCardStats(): PlaytestStats {
  return loadStats(CARD_STORAGE_KEY);
}

export function saveHumanCardStats(stats: PlaytestStats): void {
  saveStats(stats, CARD_STORAGE_KEY);
}

export function resetHumanCardStats(): void {
  resetStats(CARD_STORAGE_KEY);
}

function mergePlacementBucket(parsed: unknown): OwnPlacementBucket {
  const bucket = createEmptyPlacementBucket();
  if (!parsed || typeof parsed !== "object") return bucket;
  const p = parsed as Partial<OwnPlacementBucket>;
  if (typeof p.gamesPlayed === "number") bucket.gamesPlayed = p.gamesPlayed;
  if (typeof p.placementDeltaSum === "number") bucket.placementDeltaSum = p.placementDeltaSum;
  return bucket;
}

function mergePlacementStats(parsed: unknown): HumanPlacementStats {
  const stats = createEmptyHumanPlacementStats();
  if (!parsed || typeof parsed !== "object") return stats;
  const p = parsed as { overall?: unknown; byPlayerCount?: unknown; byCenterEffect?: unknown };
  stats.overall = mergePlacementBucket(p.overall);
  if (p.byPlayerCount && typeof p.byPlayerCount === "object") {
    for (const [key, value] of Object.entries(p.byPlayerCount as Record<string, unknown>)) {
      const playerCount = Number(key);
      if (Number.isFinite(playerCount)) stats.byPlayerCount[playerCount] = mergePlacementBucket(value);
    }
  }
  if (p.byCenterEffect && typeof p.byCenterEffect === "object") {
    for (const [key, value] of Object.entries(p.byCenterEffect as Record<string, unknown>)) {
      stats.byCenterEffect[key as CenterEffectId] = mergePlacementBucket(value);
    }
  }
  return stats;
}

export function loadHumanPlacementStats(): HumanPlacementStats {
  if (typeof window === "undefined") return createEmptyHumanPlacementStats();
  const raw = window.localStorage.getItem(PLACEMENT_STORAGE_KEY);
  if (!raw) return createEmptyHumanPlacementStats();
  try {
    return mergePlacementStats(JSON.parse(raw));
  } catch {
    return createEmptyHumanPlacementStats();
  }
}

export function saveHumanPlacementStats(stats: HumanPlacementStats): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PLACEMENT_STORAGE_KEY, JSON.stringify(stats));
}

export function resetHumanPlacementStats(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PLACEMENT_STORAGE_KEY);
}

/** One-click "save your stats" -- a single self-contained JSON blob covering both tables, meant to be pasted somewhere safe (a note, a gist) and later handed back to restoreHumanStatsBackup on any browser/session. */
export function buildHumanStatsBackup(cardStats: PlaytestStats, placementStats: HumanPlacementStats): string {
  return JSON.stringify({ cards: cardStats, placement: placementStats });
}

/**
 * The other half of buildHumanStatsBackup -- parses a pasted backup blob and writes
 * both tables into their real localStorage keys, going through the same
 * migration-safe merge normal loads use (mergeStats/mergePlacementStats) so a
 * partial, hand-edited, or slightly-stale paste still lands as a well-formed
 * PlaytestStats/HumanPlacementStats rather than corrupting either table. Returns null
 * (leaving storage untouched) only if `text` isn't valid JSON at all; anything that
 * does parse gets merged field-by-field the same way a real load would.
 */
export function restoreHumanStatsBackup(text: string): { cardStats: PlaytestStats; placementStats: HumanPlacementStats } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const p = (parsed && typeof parsed === "object" ? parsed : {}) as { cards?: unknown; placement?: unknown };
  const cardStats = mergeStats(p.cards);
  const placementStats = mergePlacementStats(p.placement);
  saveHumanCardStats(cardStats);
  saveHumanPlacementStats(placementStats);
  return { cardStats, placementStats };
}
