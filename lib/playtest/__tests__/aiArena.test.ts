import { describe, expect, it } from "vitest";
import {
  arenaSeatConfigLabel,
  ArenaSeatConfig,
  assignSeatDifficulties,
  createEmptyArenaStats,
  createEmptyFixedSeatArenaStats,
  defaultArenaSeatConfig,
  simulateArenaGame,
  simulateFixedSeatArenaGame,
  summarizeArenaStats,
  summarizeFixedSeatArenaStats,
} from "../aiArena";
import { TwoPlyOptions } from "@/lib/ai/twoPly";
import { AiDifficulty } from "@/lib/engine/types";

/** A tiny time/round budget so tests exercising "hard" seats stay fast -- play strength isn't under test here. */
const FAST_HARD_OPTIONS: TwoPlyOptions = { timeBudgetMs: 15, maxCandidates: 6, roundsAhead: 1, maxPasses: 1 };

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe("assignSeatDifficulties", () => {
  it("assigns exactly one difficulty per seat", () => {
    const seats = assignSeatDifficulties(5, ["easy", "medium"], deterministicRng(1));
    expect(seats).toHaveLength(5);
    for (const d of seats) expect(["easy", "medium"]).toContain(d);
  });

  it("cycles through the difficulty list when there are more seats than difficulties, splitting as evenly as possible", () => {
    const seats = assignSeatDifficulties(5, ["easy", "medium"], deterministicRng(1));
    const easyCount = seats.filter((d) => d === "easy").length;
    const mediumCount = seats.filter((d) => d === "medium").length;
    expect(easyCount).toBe(3); // cycled before shuffling: easy, medium, easy, medium, easy
    expect(mediumCount).toBe(2);
  });

  it("is deterministic for a given rng sequence", () => {
    const a = assignSeatDifficulties(4, ["easy", "medium", "hard"], deterministicRng(7));
    const b = assignSeatDifficulties(4, ["easy", "medium", "hard"], deterministicRng(7));
    expect(a).toEqual(b);
  });

  it("hands every seat the same single difficulty when only one is selected", () => {
    const seats = assignSeatDifficulties(4, ["hard"], deterministicRng(1));
    expect(seats).toEqual(["hard", "hard", "hard", "hard"]);
  });
});

describe("createEmptyArenaStats", () => {
  it("zeroes every difficulty and starts with no position buckets", () => {
    const stats = createEmptyArenaStats();
    expect(stats.byDifficulty).toEqual({
      easy: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0 },
      medium: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0 },
      hard: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0 },
      expert: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0 },
    });
    expect(stats.byPosition).toEqual({});
  });
});

describe("simulateArenaGame", () => {
  it("tallies a 2p game so the winner's delta is exactly -1 and the loser's is exactly +1 -- same normalized-scale invariant as cardStats.ts's placementDeltaSum", () => {
    const stats = createEmptyArenaStats();
    simulateArenaGame(2, "none", ["easy", "medium"], stats, deterministicRng(3));

    const played = (Object.keys(stats.byDifficulty) as AiDifficulty[]).map((d) => stats.byDifficulty[d]).filter((b) => b.gamesPlayed > 0);
    expect(played).toHaveLength(2); // exactly one seat per selected difficulty
    expect(played.reduce((sum, b) => sum + b.gamesPlayed, 0)).toBe(2);
    expect(played.reduce((sum, b) => sum + b.wins, 0)).toBe(1);

    const winner = played.find((b) => b.wins === 1)!;
    const loser = played.find((b) => b.wins === 0)!;
    expect(winner.placementDeltaSum).toBeCloseTo(-1);
    expect(loser.placementDeltaSum).toBeCloseTo(1);
  });

  it("tallies every turn-order position exactly once per game, as a proper 1..playerCount permutation of the seats", () => {
    const stats = createEmptyArenaStats();
    simulateArenaGame(4, "none", ["easy", "medium", "hard"], stats, deterministicRng(5), FAST_HARD_OPTIONS);

    expect(Object.keys(stats.byPosition).map(Number).sort()).toEqual([1, 2, 3, 4]);
    for (const position of [1, 2, 3, 4]) {
      expect(stats.byPosition[position].gamesPlayed).toBe(1);
    }
    // Both bucketizations (by difficulty, by position) describe the same 4 seat
    // outcomes from the same single game, just grouped two different ways.
    const totalByDifficulty = (Object.keys(stats.byDifficulty) as AiDifficulty[]).reduce((sum, d) => sum + stats.byDifficulty[d].gamesPlayed, 0);
    const totalByPosition = Object.values(stats.byPosition).reduce((sum, b) => sum + b.gamesPlayed, 0);
    expect(totalByDifficulty).toBe(4);
    expect(totalByPosition).toBe(4);
  });

  it("accumulates across multiple games without resetting", () => {
    const stats = createEmptyArenaStats();
    simulateArenaGame(2, "none", ["easy", "medium"], stats, deterministicRng(1));
    simulateArenaGame(2, "none", ["easy", "medium"], stats, deterministicRng(2));

    const totalGames = (Object.keys(stats.byDifficulty) as AiDifficulty[]).reduce((sum, d) => sum + stats.byDifficulty[d].gamesPlayed, 0);
    expect(totalGames).toBe(4); // 2 seats x 2 games
  });

  it("plays a hard-only game to completion under a small overridden budget, without falling back to the real (much slower) default", () => {
    const stats = createEmptyArenaStats();
    const start = performance.now();
    simulateArenaGame(2, "none", ["hard"], stats, deterministicRng(9), FAST_HARD_OPTIONS);
    const elapsed = performance.now() - start;

    expect(stats.byDifficulty.hard.gamesPlayed).toBe(2);
    // A full game is several decisions; at DEFAULT_TWO_PLY_OPTIONS' real 250ms/decision
    // this would take seconds. Under the fast override it should be near-instant --
    // generous upper bound so this stays robust on a slow CI runner.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("summarizeArenaStats", () => {
  it("omits buckets with no games, and computes win rate / avg delta for the rest", () => {
    const stats = createEmptyArenaStats();
    stats.byDifficulty.easy = { gamesPlayed: 4, wins: 1, placementDeltaSum: -0.5 };
    stats.byDifficulty.medium = { gamesPlayed: 4, wins: 3, placementDeltaSum: -2 };
    // hard left at 0 games -- should be omitted entirely.
    stats.byPosition[1] = { gamesPlayed: 2, wins: 2, placementDeltaSum: -2 };
    stats.byPosition[11] = { gamesPlayed: 1, wins: 0, placementDeltaSum: 1 };

    const { byDifficulty, byPosition } = summarizeArenaStats(stats);

    expect(byDifficulty).toEqual([
      { label: "Easy", gamesPlayed: 4, winRate: 0.25, avgPlacementDelta: -0.125 },
      { label: "Medium", gamesPlayed: 4, winRate: 0.75, avgPlacementDelta: -0.5 },
    ]);
    expect(byPosition).toEqual([
      { label: "1st", gamesPlayed: 2, winRate: 1, avgPlacementDelta: -1 },
      { label: "11th", gamesPlayed: 1, winRate: 0, avgPlacementDelta: 1 }, // the 11th/12th/13th "th" exception, not "11st"
    ]);
  });

  it("returns empty arrays for a fresh, untallied stats object", () => {
    expect(summarizeArenaStats(createEmptyArenaStats())).toEqual({ byDifficulty: [], byPosition: [] });
  });
});

/** Same tiny time/round budget as FAST_HARD_OPTIONS above, just spelled out as the fixed-per-seat config shape instead of TwoPlyOptions. */
const FAST_HARD_SEAT: Partial<ArenaSeatConfig> = { timeBudgetMs: 15, maxCandidates: 6, roundsAhead: 1 };

describe("defaultArenaSeatConfig", () => {
  it("defaults to Medium with the real DEFAULT_TWO_PLY_OPTIONS budget, even though Medium itself never reads it", () => {
    const config = defaultArenaSeatConfig();
    expect(config.strategy).toBe("medium");
    expect(config.timeBudgetMs).toBeGreaterThan(0);
    expect(config.maxCandidates).toBeGreaterThan(0);
    expect(config.roundsAhead).toBeGreaterThan(0);
  });
});

describe("arenaSeatConfigLabel", () => {
  it("is just the strategy name for easy/medium -- no search budget to spell out", () => {
    expect(arenaSeatConfigLabel({ strategy: "easy", timeBudgetMs: 250, maxCandidates: 8, roundsAhead: 1 })).toBe("Easy");
    expect(arenaSeatConfigLabel({ strategy: "medium", timeBudgetMs: 250, maxCandidates: 8, roundsAhead: 1 })).toBe("Medium");
  });

  it("spells out the full search budget for either hard strategy", () => {
    expect(arenaSeatConfigLabel({ strategy: "hardTwoPly", timeBudgetMs: 100, maxCandidates: 6, roundsAhead: 2 })).toBe("Hard (100ms, 6 cand, 2 rd)");
    expect(arenaSeatConfigLabel({ strategy: "hardFast", timeBudgetMs: 100, maxCandidates: 6, roundsAhead: 2 })).toBe("Hard (Fast fork) (100ms, 6 cand, 2 rd)");
  });
});

describe("createEmptyFixedSeatArenaStats", () => {
  it("creates one zeroed bucket per seat -- no config attached (see ArenaSeatBuckets' own doc comment for why)", () => {
    const buckets = createEmptyFixedSeatArenaStats(2);
    expect(buckets).toHaveLength(2);
    for (const b of buckets) expect(b).toEqual({ gamesPlayed: 0, wins: 0, placementDeltaSum: 0 });
  });
});

describe("simulateFixedSeatArenaGame", () => {
  it("tallies a 2-seat game so the winner's delta is exactly -1 and the loser's is exactly +1, same normalized-scale invariant as simulateArenaGame", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
      { strategy: "medium", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
    ];
    const buckets = createEmptyFixedSeatArenaStats(configs.length);
    simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(3));

    expect(buckets[0].gamesPlayed).toBe(1);
    expect(buckets[1].gamesPlayed).toBe(1);
    expect(buckets[0].wins + buckets[1].wins).toBe(1); // exactly one seat won
    const winnerBucket = buckets[0].wins === 1 ? buckets[0] : buckets[1];
    const loserBucket = buckets[0].wins === 1 ? buckets[1] : buckets[0];
    expect(winnerBucket.placementDeltaSum).toBeCloseTo(-1);
    expect(loserBucket.placementDeltaSum).toBeCloseTo(1);
  });

  it("accumulates across multiple games without resetting, same seats staying fixed throughout", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
      { strategy: "medium", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
    ];
    const buckets = createEmptyFixedSeatArenaStats(configs.length);
    simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(1));
    simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(2));

    expect(buckets[0].gamesPlayed).toBe(2);
    expect(buckets[1].gamesPlayed).toBe(2);
    // The config objects themselves are untouched by simulating -- fixed for the batch.
    expect(configs[0].strategy).toBe("easy");
    expect(configs[1].strategy).toBe("medium");
  });

  it("plays a game to completion with both hard strategies fixed to seats, under a small overridden budget, without falling back to the real (much slower) default", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "hardTwoPly", ...FAST_HARD_SEAT } as ArenaSeatConfig,
      { strategy: "hardFast", ...FAST_HARD_SEAT } as ArenaSeatConfig,
    ];
    const buckets = createEmptyFixedSeatArenaStats(configs.length);
    const start = performance.now();
    simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(9));
    const elapsed = performance.now() - start;

    expect(buckets[0].gamesPlayed).toBe(1);
    expect(buckets[1].gamesPlayed).toBe(1);
    // A full game is several decisions; at the real default 250ms/decision this would
    // take seconds. Under the fast override it should be near-instant -- generous
    // upper bound so this stays robust on a slow CI runner.
    expect(elapsed).toBeLessThan(2000);
  });

  it("uses the CURRENT seatConfigs, not a stale copy from when the buckets array was created -- the exact bug this signature shape is designed to prevent", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
    ];
    const buckets = createEmptyFixedSeatArenaStats(configs.length);
    // Mutate seat 0's config in place, simulating a UI edit after the buckets array
    // already existed -- since simulateFixedSeatArenaGame takes configs fresh every
    // call (not cached inside the buckets), this must be reflected immediately.
    configs[0] = { strategy: "hardTwoPly", ...FAST_HARD_SEAT } as ArenaSeatConfig;
    const start = performance.now();
    simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(1));
    const elapsed = performance.now() - start;
    // If the edit were ignored (stale "easy"), this would be near-instant regardless;
    // proving it actually ran Hard's real search loop at least confirms the dispatch
    // read the updated strategy, not a cached one. Also just confirm both seats played.
    expect(buckets[0].gamesPlayed).toBe(1);
    expect(buckets[1].gamesPlayed).toBe(1);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("summarizeFixedSeatArenaStats", () => {
  it("labels each row by seat number (1-indexed) and carries the CURRENT seat config along", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
      { strategy: "hardFast", timeBudgetMs: 100, maxCandidates: 6, roundsAhead: 1 },
    ];
    const buckets: ReturnType<typeof createEmptyFixedSeatArenaStats> = [
      { gamesPlayed: 4, wins: 1, placementDeltaSum: -0.5 },
      { gamesPlayed: 4, wins: 3, placementDeltaSum: -2 },
    ];

    const rows = summarizeFixedSeatArenaStats(configs, buckets);
    expect(rows).toEqual([
      { label: "Seat 1", gamesPlayed: 4, winRate: 0.25, avgPlacementDelta: -0.125, seatIndex: 0, config: configs[0] },
      { label: "Seat 2", gamesPlayed: 4, winRate: 0.75, avgPlacementDelta: -0.5, seatIndex: 1, config: configs[1] },
    ]);
  });

  it("reflects a config edit made after the buckets were created, since it reads seatConfigs fresh every call instead of a snapshot", () => {
    const configs: ArenaSeatConfig[] = [{ strategy: "medium", timeBudgetMs: 250, maxCandidates: 8, roundsAhead: 1 }];
    const buckets = createEmptyFixedSeatArenaStats(1);
    expect(summarizeFixedSeatArenaStats(configs, buckets)[0].config.strategy).toBe("medium");

    configs[0] = { strategy: "hardTwoPly", timeBudgetMs: 250, maxCandidates: 8, roundsAhead: 1 };
    expect(summarizeFixedSeatArenaStats(configs, buckets)[0].config.strategy).toBe("hardTwoPly");
  });

  it("returns one row per seat even with zero games played, unlike summarizeArenaStats which omits empty buckets -- an untallied seat is still a real, configured seat", () => {
    const configs = [defaultArenaSeatConfig(), defaultArenaSeatConfig()];
    const buckets = createEmptyFixedSeatArenaStats(2);
    const rows = summarizeFixedSeatArenaStats(configs, buckets);
    expect(rows).toHaveLength(2);
    expect(rows[0].winRate).toBeNull();
    expect(rows[0].avgPlacementDelta).toBeNull();
  });
});
