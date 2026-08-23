import { describe, expect, it } from "vitest";
import { summarizeArenaStats, summarizeFixedSeatArenaStats } from "../aiArena";
import { loadArenaState, PersistedArenaState, saveArenaState } from "../arenaStore";

/** Same pattern as store.test.ts -- see its own doc comment for why the mock exists. */
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

describe("loadArenaState", () => {
  it("fills in fields missing from a bucket saved before they existed, instead of leaving them undefined -- the exact NaN bug this migration exists to prevent", () => {
    withMockLocalStorage(() => {
      // A pre-votesCast/votesYes shape, same as anything saved before that feature shipped.
      const legacyShape = {
        mode: "shuffle",
        playerCount: 4,
        centerEffect: "none",
        selectedDifficulties: ["easy", "medium"],
        gameCount: 10,
        hardBudgetMs: 75,
        stats: {
          byDifficulty: {
            easy: { gamesPlayed: 4, wins: 1, placementDeltaSum: -0.5, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0 },
            medium: { gamesPlayed: 4, wins: 3, placementDeltaSum: -2, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0 },
          },
          byPosition: {
            1: { gamesPlayed: 4, wins: 2, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0 },
          },
        },
        seatConfigs: [],
        seatBuckets: [{ gamesPlayed: 2, wins: 1, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0 }],
      };
      window.localStorage.setItem("board-game:arena-state", JSON.stringify(legacyShape));

      const loaded = loadArenaState();
      expect(loaded.stats.byDifficulty.easy.votesCast).toBe(0);
      expect(loaded.stats.byDifficulty.easy.votesYes).toBe(0);
      expect(loaded.stats.byPosition[1].votesCast).toBe(0);
      expect(loaded.seatBuckets[0].votesCast).toBe(0);

      // The actual user-visible symptom: summarizeBucket's division must land on
      // null ("no data yet"), never NaN (undefined / undefined).
      const { byDifficulty } = summarizeArenaStats(loaded.stats);
      for (const row of byDifficulty) expect(row.avgVoteEndRate).toBeNull();
      const bySeat = summarizeFixedSeatArenaStats([{ strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 }], loaded.seatBuckets);
      expect(bySeat[0].avgVoteEndRate).toBeNull();
    });
  });

  it("round-trips a fresh save/load without corrupting real vote data", () => {
    withMockLocalStorage(() => {
      const state: PersistedArenaState = {
        ...loadArenaState(),
        stats: {
          ...loadArenaState().stats,
          byDifficulty: {
            ...loadArenaState().stats.byDifficulty,
            easy: { gamesPlayed: 4, wins: 1, placementDeltaSum: -0.5, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 10, votesYes: 4, roundLengthSum: 20 },
          },
        },
      };
      saveArenaState(state);
      const loaded = loadArenaState();
      expect(loaded.stats.byDifficulty.easy.votesCast).toBe(10);
      expect(loaded.stats.byDifficulty.easy.votesYes).toBe(4);
      expect(loaded.stats.byDifficulty.easy.roundLengthSum).toBe(20);
    });
  });

  it("treats a non-array seatBuckets blob as empty rather than throwing", () => {
    withMockLocalStorage(() => {
      window.localStorage.setItem("board-game:arena-state", JSON.stringify({ seatBuckets: "not an array" }));
      expect(loadArenaState().seatBuckets).toEqual([]);
    });
  });
});
