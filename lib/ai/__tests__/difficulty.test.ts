import { describe, expect, it } from "vitest";
import { AI_DIFFICULTIES, AI_DIFFICULTY_LABELS, chooseAiActionForDifficulty, DEFAULT_AI_DIFFICULTY } from "../difficulty";
import { chooseGreedyAiAction } from "../greedyAi";
import { chooseRandomAiAction } from "../randomAi";
import { chooseTwoPlyAction, TwoPlyOptions } from "../twoPly";
import { applyAction, createGame, DEFAULT_2P_CONFIG } from "../../engine/game";
import { currentPlayerId } from "../../engine/turns";
import { GameState } from "../../engine/types";

/**
 * A tiny, deterministic budget so difficulty-dispatch tests stay fast -- play strength
 * isn't under test here. maxRounds (not just timeBudgetMs) matters for the "identical
 * output with the same seed" test below: how many samples get evaluated under a
 * wall-clock-only budget varies run to run with real timing, which would make two
 * "same seed" calls consume `rng` a different number of times and diverge.
 */
const FAST_TWO_PLY_OPTIONS: TwoPlyOptions = { timeBudgetMs: 50, maxCandidates: 6, roundsAhead: 1, maxPasses: 2 };

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** Whoever has a decision to make right now: the current turn player, or (during a vote) the next player who hasn't cast one yet. */
function activePlayerId(state: GameState): string {
  if (state.phase === "voting") {
    const pending = state.players.find((p) => !(p.id in state.votes));
    if (!pending) throw new Error("no pending voter, but phase is still 'voting'");
    return pending.id;
  }
  return currentPlayerId(state);
}

describe("chooseAiActionForDifficulty", () => {
  it("routes 'easy' to the random strategy -- identical output to calling chooseRandomAiAction directly with the same seed", () => {
    const state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, deterministicRng(1));
    const viaDispatcher = chooseAiActionForDifficulty(state, "p1", "easy", deterministicRng(5));
    const viaDirect = chooseRandomAiAction(state, "p1", deterministicRng(5));
    expect(viaDispatcher).toEqual(viaDirect);
  });

  it("routes 'medium' to the greedy strategy -- identical output to calling chooseGreedyAiAction directly with the same seed", () => {
    const state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, deterministicRng(1));
    const viaDispatcher = chooseAiActionForDifficulty(state, "p1", "medium", deterministicRng(5));
    const viaDirect = chooseGreedyAiAction(state, "p1", deterministicRng(5));
    expect(viaDispatcher).toEqual(viaDirect);
  });

  it("routes 'hard' to the two-ply strategy -- identical output to calling chooseTwoPlyAction directly with the same seed and options", () => {
    const state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, deterministicRng(1));
    const viaDispatcher = chooseAiActionForDifficulty(state, "p1", "hard", deterministicRng(5), FAST_TWO_PLY_OPTIONS);
    const viaDirect = chooseTwoPlyAction(state, "p1", FAST_TWO_PLY_OPTIONS, deterministicRng(5));
    expect(viaDispatcher).toEqual(viaDirect);
  });

  it("defaults rng to Math.random when omitted -- doesn't throw", () => {
    const state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, deterministicRng(1));
    expect(() => chooseAiActionForDifficulty(state, "p1", "medium")).not.toThrow();
  });

  it("AI_DIFFICULTIES lists every difficulty exactly once, with a label for each", () => {
    expect(AI_DIFFICULTIES).toEqual(["easy", "medium", "hard"]);
    for (const d of AI_DIFFICULTIES) expect(AI_DIFFICULTY_LABELS[d]).toBeTruthy();
  });

  it("defaults to medium", () => {
    expect(DEFAULT_AI_DIFFICULTY).toBe("medium");
  });

  it("plays a full game legally at every difficulty", () => {
    for (const difficulty of AI_DIFFICULTIES) {
      const rng = deterministicRng(3);
      let state: GameState = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, rng);
      let iterations = 0;
      while (state.phase !== "ended" && iterations < 500) {
        const playerId = activePlayerId(state);
        const action = chooseAiActionForDifficulty(state, playerId, difficulty, rng, FAST_TWO_PLY_OPTIONS);
        state = applyAction(state, action, rng);
        iterations++;
      }
      expect(state.phase).toBe("ended");
    }
  });
});
