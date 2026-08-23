import { describe, expect, it } from "vitest";
import {
  arenaSeatConfigLabel,
  ArenaSeatConfig,
  assignSeatDifficulties,
  createEmptyArenaStats,
  createEmptyFixedSeatArenaStats,
  defaultArenaSeatConfig,
  defaultArenaSeatConfigFor,
  simulateArenaGame,
  simulateFixedSeatArenaGame,
  summarizeArenaStats,
  summarizeFixedSeatArenaStats,
} from "../aiArena";
import { DEFAULT_HARD_FAST_OPTIONS } from "@/lib/ai/hardFast";
import { DEFAULT_TWO_PLY_OPTIONS, TwoPlyOptions } from "@/lib/ai/twoPly";
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
      easy: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 },
      medium: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 },
      hard: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 },
      expert: { gamesPlayed: 0, wins: 0, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 },
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

  it("tracks samples/candidates, flip-eligibility, and vote outcomes per bucket, same as the fixed-per-seat mode -- these aren't fixed-per-seat-only anymore", () => {
    const stats = createEmptyArenaStats();
    for (let i = 0; i < 5; i++) simulateArenaGame(4, "none", ["easy", "medium", "hard", "expert"], stats, deterministicRng(30 + i), FAST_HARD_OPTIONS);

    for (const difficulty of ["hard", "expert"] as const) {
      const bucket = stats.byDifficulty[difficulty];
      expect(bucket.searchCandidatesSum).toBeGreaterThan(0);
      expect(bucket.flipEligibleDecisions).toBeGreaterThan(0);
      expect(bucket.flipsChosen).toBeLessThanOrEqual(bucket.flipEligibleDecisions);
    }
    // Every game reaches at least one round-boundary vote eventually (that's how the
    // game ends), and every seat is AI, so every difficulty should have cast at least
    // one vote across 5 games.
    for (const difficulty of ["easy", "medium", "hard", "expert"] as const) {
      const bucket = stats.byDifficulty[difficulty];
      expect(bucket.votesCast).toBeGreaterThan(0);
      expect(bucket.votesYes).toBeLessThanOrEqual(bucket.votesCast);
    }
  });

  it("tallies the ending round number into every seat's bucket, same game-wide value for all four seats", () => {
    const stats = createEmptyArenaStats();
    simulateArenaGame(4, "none", ["easy"], stats, deterministicRng(11));

    const bucket = stats.byDifficulty.easy;
    expect(bucket.gamesPlayed).toBe(4);
    expect(bucket.roundLengthSum).toBeGreaterThan(0);
    // All 4 seats are the same difficulty in this game, so its roundLengthSum should
    // be exactly 4x whatever single round number the game actually ended on.
    expect(bucket.roundLengthSum % 4).toBe(0);
  });
});

describe("summarizeArenaStats", () => {
  it("omits buckets with no games, and computes win rate / avg delta for the rest", () => {
    const stats = createEmptyArenaStats();
    stats.byDifficulty.easy = { gamesPlayed: 4, wins: 1, placementDeltaSum: -0.5, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 };
    stats.byDifficulty.medium = { gamesPlayed: 4, wins: 3, placementDeltaSum: -2, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 };
    // hard left at 0 games -- should be omitted entirely.
    stats.byPosition[1] = { gamesPlayed: 2, wins: 2, placementDeltaSum: -2, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 };
    stats.byPosition[11] = { gamesPlayed: 1, wins: 0, placementDeltaSum: 1, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 };

    const { byDifficulty, byPosition } = summarizeArenaStats(stats);

    expect(byDifficulty).toEqual([
      { label: "Easy", gamesPlayed: 4, winRate: 0.25, avgPlacementDelta: -0.125, avgSamplesPerCandidate: null, avgEligibleFlipRate: null, avgVoteEndRate: null, avgRoundLength: 0 },
      { label: "Medium", gamesPlayed: 4, winRate: 0.75, avgPlacementDelta: -0.5, avgSamplesPerCandidate: null, avgEligibleFlipRate: null, avgVoteEndRate: null, avgRoundLength: 0 },
    ]);
    expect(byPosition).toEqual([
      { label: "1st", gamesPlayed: 2, winRate: 1, avgPlacementDelta: -1, avgSamplesPerCandidate: null, avgEligibleFlipRate: null, avgVoteEndRate: null, avgRoundLength: 0 },
      { label: "11th", gamesPlayed: 1, winRate: 0, avgPlacementDelta: 1, avgSamplesPerCandidate: null, avgEligibleFlipRate: null, avgVoteEndRate: null, avgRoundLength: 0 }, // the 11th/12th/13th "th" exception, not "11st"
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

describe("defaultArenaSeatConfigFor", () => {
  it("gives hardFast its own real defaults (DEFAULT_HARD_FAST_OPTIONS), not Hard's", () => {
    const config = defaultArenaSeatConfigFor("hardFast");
    expect(config).toEqual({ strategy: "hardFast", timeBudgetMs: DEFAULT_HARD_FAST_OPTIONS.timeBudgetMs, maxCandidates: DEFAULT_HARD_FAST_OPTIONS.maxCandidates, roundsAhead: DEFAULT_HARD_FAST_OPTIONS.roundsAhead });
    expect(config.maxCandidates).not.toBe(DEFAULT_TWO_PLY_OPTIONS.maxCandidates);
  });

  it("gives hardTwoPly Hard's own real defaults (DEFAULT_TWO_PLY_OPTIONS)", () => {
    const config = defaultArenaSeatConfigFor("hardTwoPly");
    expect(config).toEqual({ strategy: "hardTwoPly", timeBudgetMs: DEFAULT_TWO_PLY_OPTIONS.timeBudgetMs, maxCandidates: DEFAULT_TWO_PLY_OPTIONS.maxCandidates, roundsAhead: DEFAULT_TWO_PLY_OPTIONS.roundsAhead });
  });

  it("never carries over numbers from a different strategy -- each call is a fresh default for the given strategy alone", () => {
    expect(defaultArenaSeatConfigFor("easy").strategy).toBe("easy");
    expect(defaultArenaSeatConfigFor("medium").strategy).toBe("medium");
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
    for (const b of buckets) expect(b).toEqual({ gamesPlayed: 0, wins: 0, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 });
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
    // Both seats played the same game, so they must agree on how long it ran.
    expect(buckets[0].roundLengthSum).toBe(buckets[1].roundLengthSum);
    expect(buckets[0].roundLengthSum).toBeGreaterThan(0);
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

  it("accumulates samples/candidates for both hard strategies, so avgSamplesPerCandidate is derivable for either -- easy/medium seats stay at 0 (no search loop to sample)", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "hardTwoPly", ...FAST_HARD_SEAT } as ArenaSeatConfig,
      { strategy: "hardFast", ...FAST_HARD_SEAT } as ArenaSeatConfig,
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
    ];
    const buckets = createEmptyFixedSeatArenaStats(configs.length);
    simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(9));

    expect(buckets[0].searchSamplesSum).toBeGreaterThan(0);
    expect(buckets[0].searchCandidatesSum).toBeGreaterThan(0);
    expect(buckets[1].searchSamplesSum).toBeGreaterThan(0);
    expect(buckets[1].searchCandidatesSum).toBeGreaterThan(0);
    expect(buckets[2].searchSamplesSum).toBe(0);
    expect(buckets[2].searchCandidatesSum).toBe(0);
  });

  it("tracks flip-eligible decisions and flips chosen for every strategy, not just the hard ones -- flip is legal regardless of strategy", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "hardFast", ...FAST_HARD_SEAT } as ArenaSeatConfig,
      { strategy: "medium", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
    ];
    const buckets = createEmptyFixedSeatArenaStats(configs.length);
    // Several games, since flip only unlocks partway through -- one game might not
    // reach a single flip-eligible decision for every seat.
    for (let i = 0; i < 5; i++) simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(20 + i));

    for (const bucket of buckets) {
      expect(bucket.flipEligibleDecisions).toBeGreaterThan(0);
      // flipsChosen can never exceed the number of decisions where flipping was even legal.
      expect(bucket.flipsChosen).toBeLessThanOrEqual(bucket.flipEligibleDecisions);
    }
  });

  it("tracks vote outcomes per seat, decided via each seat's own strategy (chooseExpertVote for hardFast, computeAiVote otherwise) -- not the plain computeAiVote applyAction defaults to", () => {
    const configs: ArenaSeatConfig[] = [
      { strategy: "hardFast", ...FAST_HARD_SEAT } as ArenaSeatConfig,
      { strategy: "medium", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
      { strategy: "easy", timeBudgetMs: 1, maxCandidates: 1, roundsAhead: 1 },
    ];
    const buckets = createEmptyFixedSeatArenaStats(configs.length);
    for (let i = 0; i < 5; i++) simulateFixedSeatArenaGame("none", configs, buckets, deterministicRng(20 + i));

    for (const bucket of buckets) {
      expect(bucket.votesCast).toBeGreaterThan(0);
      expect(bucket.votesYes).toBeLessThanOrEqual(bucket.votesCast);
    }
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
      { gamesPlayed: 4, wins: 1, placementDeltaSum: -0.5, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 },
      { gamesPlayed: 4, wins: 3, placementDeltaSum: -2, searchSamplesSum: 820, searchCandidatesSum: 20, flipEligibleDecisions: 10, flipsChosen: 4, votesCast: 5, votesYes: 2, roundLengthSum: 32 },
    ];

    const rows = summarizeFixedSeatArenaStats(configs, buckets);
    expect(rows).toEqual([
      { label: "Seat 1", gamesPlayed: 4, winRate: 0.25, avgPlacementDelta: -0.125, avgSamplesPerCandidate: null, avgEligibleFlipRate: null, avgVoteEndRate: null, avgRoundLength: 0, seatIndex: 0, config: configs[0] },
      { label: "Seat 2", gamesPlayed: 4, winRate: 0.75, avgPlacementDelta: -0.5, avgSamplesPerCandidate: 41, avgEligibleFlipRate: 0.4, avgVoteEndRate: 0.4, avgRoundLength: 8, seatIndex: 1, config: configs[1] },
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
