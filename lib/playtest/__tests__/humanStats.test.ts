import { describe, expect, it } from "vitest";
import { ResolvedCard } from "@/lib/engine/resolution";
import { createEmptyStats } from "../cardStats";
import {
  avgPlacementDelta,
  buildHumanStatsBackup,
  createEmptyHumanPlacementStats,
  loadHumanCardStats,
  loadHumanPlacementStats,
  resetHumanCardStats,
  resetHumanPlacementStats,
  restoreHumanStatsBackup,
  saveHumanCardStats,
  saveHumanPlacementStats,
  tallyHumanGame,
} from "../humanStats";

/** Same file-scoped stub used by store.test.ts -- see its own doc comment for why. */
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

function resolved(cardId: ResolvedCard["cardId"], ownerId: string, finalValue: number): ResolvedCard {
  return {
    instanceId: `${cardId}-${ownerId}-${finalValue}`,
    cardId,
    ownerId,
    position: { x: 0, y: 0 },
    faceUp: true,
    baseValue: finalValue,
    finalValue,
    negated: false,
    breakdown: [{ label: "Base", amount: finalValue, source: "self" }],
  };
}

describe("tallyHumanGame", () => {
  it("only tallies the human's own cards into cardStats, never an opponent's", () => {
    const cardStats = createEmptyStats();
    const placementStats = createEmptyHumanPlacementStats();
    const cards = [resolved("Footman", "human", 5), resolved("Warlord", "ai-1", 8)];
    tallyHumanGame(cardStats, placementStats, cards, { human: 5, "ai-1": 8 }, 2, 3, "none", "human");

    expect(cardStats.cards.Footman.played).toBe(1);
    expect(cardStats.cards.Warlord.played).toBe(0);
  });

  it("records the human's own rank (as a delta against that game's baseline and scale), not an opponent's", () => {
    const cardStats = createEmptyStats();
    const placementStats = createEmptyHumanPlacementStats();
    const cards = [resolved("Footman", "human", 5), resolved("Warlord", "ai-1", 8)];
    // Human scores lower here -- 2nd of 2, baseline 1.5, max deviation 0.5, so delta
    // (2 - 1.5) / 0.5 = +1 (the worst possible finish at 2p).
    tallyHumanGame(cardStats, placementStats, cards, { human: 5, "ai-1": 8 }, 2, 3, "none", "human");

    expect(placementStats.overall.gamesPlayed).toBe(1);
    expect(avgPlacementDelta(placementStats.overall)).toBe(1);
  });

  it("splits placement history by player count and by location, each comparable despite the size difference", () => {
    const cardStats = createEmptyStats();
    const placementStats = createEmptyHumanPlacementStats();
    // A 2p win -- rank 1, baseline 1.5, max deviation 0.5, delta -1 (best possible finish).
    tallyHumanGame(cardStats, placementStats, [resolved("Footman", "human", 10)], { human: 10, "ai-1": 5 }, 2, 3, "frontier", "human");
    // A 4p last place at a different location -- rank 4, baseline 2.5, max deviation
    // 1.5, delta +1 (worst possible finish, same magnitude as the 2p win above despite
    // the different player count).
    tallyHumanGame(
      cardStats,
      placementStats,
      [resolved("Footman", "human", 1)],
      { human: 1, "ai-1": 10, "ai-2": 8, "ai-3": 6 },
      4,
      3,
      "mirrorPool",
      "human"
    );

    expect(placementStats.overall.gamesPlayed).toBe(2);
    expect(avgPlacementDelta(placementStats.byPlayerCount[2])).toBe(-1);
    expect(avgPlacementDelta(placementStats.byPlayerCount[4])).toBe(1);
    expect(avgPlacementDelta(placementStats.byCenterEffect.frontier)).toBe(-1);
    expect(avgPlacementDelta(placementStats.byCenterEffect.mirrorPool)).toBe(1);
  });
});

describe("avgPlacementDelta", () => {
  it("returns null (not 0/NaN) for a bucket with no games yet", () => {
    const bucket = createEmptyHumanPlacementStats().overall;
    expect(avgPlacementDelta(bucket)).toBeNull();
  });
});

describe("human stats persistence", () => {
  it("round-trips card stats through their own localStorage key, independent of the placement stats", () => {
    withMockLocalStorage(() => {
      const cardStats = createEmptyStats();
      cardStats.cards.Footman.played = 3;
      saveHumanCardStats(cardStats);

      const placementStats = createEmptyHumanPlacementStats();
      placementStats.overall.gamesPlayed = 3;
      placementStats.overall.placementDeltaSum = -1.5;
      saveHumanPlacementStats(placementStats);

      expect(loadHumanCardStats().cards.Footman.played).toBe(3);
      expect(loadHumanPlacementStats().overall.gamesPlayed).toBe(3);
      expect(loadHumanPlacementStats().overall.placementDeltaSum).toBe(-1.5);
    });
  });

  it("resetHumanCardStats and resetHumanPlacementStats clear only their own table", () => {
    withMockLocalStorage(() => {
      const cardStats = createEmptyStats();
      cardStats.cards.Footman.played = 3;
      saveHumanCardStats(cardStats);
      const placementStats = createEmptyHumanPlacementStats();
      placementStats.overall.gamesPlayed = 3;
      saveHumanPlacementStats(placementStats);

      resetHumanCardStats();

      expect(loadHumanCardStats().cards.Footman.played).toBe(0);
      // Untouched by resetting the other table.
      expect(loadHumanPlacementStats().overall.gamesPlayed).toBe(3);

      resetHumanPlacementStats();
      expect(loadHumanPlacementStats().overall.gamesPlayed).toBe(0);
    });
  });
});

describe("buildHumanStatsBackup/restoreHumanStatsBackup", () => {
  it("round-trips both tables through a single backup blob", () => {
    withMockLocalStorage(() => {
      const cardStats = createEmptyStats();
      cardStats.cards.Footman.played = 7;
      const placementStats = createEmptyHumanPlacementStats();
      placementStats.overall.gamesPlayed = 4;
      placementStats.overall.placementDeltaSum = -2;

      const backup = buildHumanStatsBackup(cardStats, placementStats);
      const result = restoreHumanStatsBackup(backup);

      expect(result).not.toBeNull();
      expect(result!.cardStats.cards.Footman.played).toBe(7);
      expect(result!.placementStats.overall.gamesPlayed).toBe(4);
      expect(avgPlacementDelta(result!.placementStats.overall)).toBe(-0.5);
      // Also actually written to storage, not just returned.
      expect(loadHumanCardStats().cards.Footman.played).toBe(7);
      expect(loadHumanPlacementStats().overall.gamesPlayed).toBe(4);
    });
  });

  it("returns null and leaves storage untouched for text that isn't valid JSON", () => {
    withMockLocalStorage(() => {
      const cardStats = createEmptyStats();
      cardStats.cards.Footman.played = 1;
      saveHumanCardStats(cardStats);

      expect(restoreHumanStatsBackup("not json")).toBeNull();
      expect(loadHumanCardStats().cards.Footman.played).toBe(1);
    });
  });
});
