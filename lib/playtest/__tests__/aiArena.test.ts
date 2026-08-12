import { describe, expect, it } from "vitest";
import { assignSeatDifficulties, createEmptyArenaStats, simulateArenaGame, summarizeArenaStats } from "../aiArena";
import { MctsOptions } from "@/lib/ai/mcts";
import { AiDifficulty } from "@/lib/engine/types";

/** A tiny time/iteration budget so tests exercising "hard" seats stay fast -- play strength isn't under test here. */
const FAST_HARD_OPTIONS: MctsOptions = { timeBudgetMs: 15, maxSimulationDepth: 6, explorationConstant: 1.4, maxIterations: 20 };

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
    // A full game is several decisions; at DEFAULT_MCTS_OPTIONS' real 250ms/decision
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
