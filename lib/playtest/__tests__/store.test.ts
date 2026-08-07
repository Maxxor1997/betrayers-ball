import { describe, expect, it } from "vitest";
import { createEmptyBucket, createEmptyStats, placementBaseline } from "../cardStats";
import { loadStats, resetStats, saveStats } from "../store";

/**
 * The test environment runs in plain Node (see vitest.config.ts) with no `window` at
 * all -- store.ts's `typeof window === "undefined"` guards mean loadStats/saveStats
 * are no-ops there. These tests specifically need real localStorage read/write
 * behavior (that's the whole bug being covered), so they stub a minimal `window` for
 * their own duration and tear it down after, rather than switching the whole suite's
 * environment for one file.
 */
function withMockLocalStorage<T>(fn: () => T): T {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as { window?: unknown }).window = { localStorage };
  try {
    return fn();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

describe("loadStats/saveStats round-trip", () => {
  it("loads back exactly what was saved", () => {
    withMockLocalStorage(() => {
      const stats = createEmptyStats();
      stats.cards.Footman.played = 5;
      stats.cards.Footman.copiesInDeck = 20;
      stats.overall.gamesTallied = 3;
      stats.overall.roundLengthSum = 15;
      saveStats(stats);

      const loaded = loadStats();
      expect(loaded.cards.Footman.played).toBe(5);
      expect(loaded.cards.Footman.copiesInDeck).toBe(20);
      expect(loaded.overall.gamesTallied).toBe(3);
      expect(loaded.overall.roundLengthSum).toBe(15);
    });
  });

  it("resetStats clears back to a fresh empty table", () => {
    withMockLocalStorage(() => {
      const stats = createEmptyStats();
      stats.cards.Footman.played = 1;
      saveStats(stats);
      resetStats();
      expect(loadStats()).toEqual(createEmptyStats());
    });
  });

  it("returns a fresh empty table when nothing's been saved yet", () => {
    withMockLocalStorage(() => {
      expect(loadStats()).toEqual(createEmptyStats());
    });
  });

  it("falls back to an empty table on corrupt JSON instead of throwing", () => {
    withMockLocalStorage(() => {
      window.localStorage.setItem("board-game:playtest-stats", "{not json");
      expect(loadStats()).toEqual(createEmptyStats());
    });
  });

  // This is the actual bug: a stored blob from before copiesInDeck/roundLengthSum
  // existed never serialized those keys at all (JSON.stringify just omits an
  // `undefined` field). Blindly assigning the whole stored per-card object over a
  // freshly-zeroed one would leave those fields `undefined`, and every average or
  // rate built from them (playRate = played / copiesInDeck, avgRoundLength =
  // roundLengthSum / played) would silently become NaN -- not caught by a `=== 0`
  // guard, and NaN isn't `null` either, so a UI checking "is this null, show a dash"
  // would instead render "NaN%".
  it("backfills fields missing from an older stored schema instead of producing NaN", () => {
    withMockLocalStorage(() => {
      const legacyShape = {
        cards: {
          Footman: { played: 3, ownScoreSum: 6, finalScoreSum: 9, placementSum: 4 }, // no copiesInDeck, no roundLengthSum
        },
        overall: {}, // no gamesTallied, no roundLengthSum
      };
      window.localStorage.setItem("board-game:playtest-stats", JSON.stringify(legacyShape));

      const loaded = loadStats();
      expect(loaded.cards.Footman.played).toBe(3); // present fields survive
      expect(loaded.cards.Footman.copiesInDeck).toBe(0); // missing fields backfill to 0, not undefined/NaN
      expect(loaded.cards.Footman.roundLengthSum).toBe(0);
      expect(loaded.overall.gamesTallied).toBe(0);
      expect(loaded.overall.roundLengthSum).toBe(0);
      // Before the fix, a blind `stats.cards[id] = parsed.cards[id]` would have left
      // copiesInDeck literally `undefined` here (not 0) -- `undefined + n` is NaN, which
      // is what actually broke playRate. Confirming it's a real number, not NaN/undefined.
      expect(typeof loaded.cards.Footman.copiesInDeck).toBe("number");
      expect(Number.isNaN(loaded.cards.Footman.copiesInDeck)).toBe(false);
    });
  });

  it("discards the pre-wrapper flat-Record schema entirely rather than guessing a migration", () => {
    withMockLocalStorage(() => {
      // The very first shape this file ever had: Record<CardId, CardStats> with no {cards, overall} wrapper at all.
      window.localStorage.setItem("board-game:playtest-stats", JSON.stringify({ Footman: { played: 99 } }));
      expect(loadStats()).toEqual(createEmptyStats());
    });
  });

  it("round-trips byPlayerCount, backfilling missing fields within each slice the same way as the top-level total", () => {
    withMockLocalStorage(() => {
      const stats = createEmptyStats();
      stats.cards.Footman.played = 3;
      stats.overall.gamesTallied = 2;
      stats.byPlayerCount[2] = createEmptyBucket();
      stats.byPlayerCount[2].cards.Footman.played = 1;
      stats.byPlayerCount[2].overall.gamesTallied = 1;
      stats.byPlayerCount[4] = createEmptyBucket();
      stats.byPlayerCount[4].cards.Footman.played = 2;
      stats.byPlayerCount[4].overall.gamesTallied = 1;
      saveStats(stats);

      const loaded = loadStats();
      expect(loaded.byPlayerCount[2].cards.Footman.played).toBe(1);
      expect(loaded.byPlayerCount[2].overall.gamesTallied).toBe(1);
      expect(loaded.byPlayerCount[4].cards.Footman.played).toBe(2);
      expect(loaded.byPlayerCount[6]).toBeUndefined();
    });
  });

  it("a byPlayerCount slice from before roundLengthSum existed backfills to 0, not NaN", () => {
    withMockLocalStorage(() => {
      const legacyShape = {
        cards: { Footman: { played: 1 } },
        overall: {},
        byPlayerCount: {
          "2": { cards: { Footman: { played: 1 } }, overall: {} }, // no roundLengthSum anywhere in this slice
        },
      };
      window.localStorage.setItem("board-game:playtest-stats", JSON.stringify(legacyShape));

      const loaded = loadStats();
      expect(loaded.byPlayerCount[2].cards.Footman.played).toBe(1);
      expect(loaded.byPlayerCount[2].cards.Footman.roundLengthSum).toBe(0);
      expect(loaded.byPlayerCount[2].overall.roundLengthSum).toBe(0);
    });
  });

  it("ignores a byPlayerCount blob that isn't present or isn't an object, rather than throwing", () => {
    withMockLocalStorage(() => {
      window.localStorage.setItem("board-game:playtest-stats", JSON.stringify({ cards: {}, overall: {}, byPlayerCount: "not an object" }));
      expect(loadStats().byPlayerCount).toEqual({});
    });
  });

  // The actual bug report this covers: a stored blob from before placementDeltaSum
  // existed has real placementSum/played data, so defaulting the new field to 0 isn't
  // just imprecise -- it silently reports "exactly average" for every already-played
  // card, i.e. "it shows 0 for everything". Since every game in a single
  // player-count slice shares one baseline, placementDeltaSum is exactly recoverable
  // from placementSum/played rather than defaulted.
  it("reconstructs placementDeltaSum for a byPlayerCount slice from placementSum/played instead of defaulting to 0", () => {
    withMockLocalStorage(() => {
      // 5 placements at 2p (baseline 1.5) summing to rank total 6 -- e.g. some mix of
      // 1st/2nd finishes. Old schema: no placementDeltaSum key anywhere.
      const legacyShape = {
        cards: {},
        overall: {},
        byPlayerCount: {
          "2": { cards: { Footman: { played: 5, placementSum: 6 } }, overall: {} },
        },
      };
      window.localStorage.setItem("board-game:playtest-stats", JSON.stringify(legacyShape));

      const loaded = loadStats();
      const expected = 6 - 5 * placementBaseline(2);
      expect(loaded.byPlayerCount[2].cards.Footman.placementDeltaSum).toBeCloseTo(expected);
      expect(expected).not.toBe(0); // sanity: this legacy fixture isn't a case where 0 would coincidentally be right
    });
  });

  it("reconstructs the blended top-level placementDeltaSum by summing the recovered byPlayerCount slices, not by defaulting to 0", () => {
    withMockLocalStorage(() => {
      const legacyShape = {
        cards: { Footman: { played: 8, placementSum: 12 } }, // no placementDeltaSum -- can't be derived here directly, mixes baselines
        overall: {},
        byPlayerCount: {
          "2": { cards: { Footman: { played: 5, placementSum: 6 } }, overall: {} },
          "8": { cards: { Footman: { played: 3, placementSum: 6 } }, overall: {} },
        },
      };
      window.localStorage.setItem("board-game:playtest-stats", JSON.stringify(legacyShape));

      const loaded = loadStats();
      const expected = (6 - 5 * placementBaseline(2)) + (6 - 3 * placementBaseline(8));
      expect(loaded.cards.Footman.placementDeltaSum).toBeCloseTo(expected);
      expect(expected).not.toBe(0);
    });
  });

  it("leaves placementDeltaSum at a safe 0 (can't be recovered) when there's no byPlayerCount data to reconstruct it from", () => {
    withMockLocalStorage(() => {
      // Data old enough to predate the byPlayerCount feature itself -- genuinely no way to know each game's player count.
      const legacyShape = { cards: { Footman: { played: 4, placementSum: 6 } }, overall: {} };
      window.localStorage.setItem("board-game:playtest-stats", JSON.stringify(legacyShape));

      const loaded = loadStats();
      expect(loaded.cards.Footman.played).toBe(4); // real fields still survive
      expect(loaded.cards.Footman.placementDeltaSum).toBe(0); // last-resort safe default, not NaN/undefined
    });
  });
});
