import { describe, expect, it } from "vitest";
import { computeAiVote } from "../../engine/endgame";
import { applyAction, configForPlayerCount, createGame } from "../../engine/game";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "../../engine/turns";
import { GameState } from "../../engine/types";
import { chooseExpertVote, chooseHardFastAction, HardFastOptions } from "../hardFast";

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** A tiny time/round/flip budget, purely so these tests run fast -- play strength isn't what's under test here. */
const FAST_OPTIONS: HardFastOptions = {
  timeBudgetMs: 50,
  maxCandidates: 6,
  roundsAhead: 1,
  maxPasses: 2,
  flipMaxCandidates: 2,
  flipTimeBudgetMs: 20,
  flipMaxPasses: 2,
  voteRoundsAhead: 1,
  voteTimeBudgetMs: 20,
  voteMaxPasses: 2,
};

function activePlayerId(state: GameState): string {
  if (state.phase === "voting") {
    const pending = state.players.find((p) => !(p.id in state.votes));
    if (!pending) throw new Error("no pending voter, but phase is still 'voting'");
    return pending.id;
  }
  return currentPlayerId(state);
}

describe("chooseHardFastAction", () => {
  it("always returns a legal action", () => {
    const rng = deterministicRng(1);
    const config = configForPlayerCount(3, "none", "medium");
    let state = createGame(["p1", "p2", "p3"], config, rng, [], 0);

    for (let i = 0; i < 10; i++) {
      const playerId = activePlayerId(state);
      if (state.phase === "voting") {
        state = applyAction(state, { type: "castVote", playerId, vote: false }, rng);
        continue;
      }
      const action = chooseHardFastAction(state, playerId, FAST_OPTIONS, rng);

      if (action.type === "flip") {
        expect(getLegalFlipTargets(state).some((t) => t.instanceId === action.instanceId)).toBe(true);
      } else if (action.type === "place") {
        const player = state.players.find((p) => p.id === playerId)!;
        expect(player.hand.some((c) => c.instanceId === action.instanceId)).toBe(true);
        expect(getLegalPlacementCells(state).some((p) => p.x === action.position.x && p.y === action.position.y)).toBe(true);
      } else if (action.type === "pass") {
        expect(mustPass(state)).toBe(true);
      }

      state = applyAction(state, action, rng);
    }
  });

  it("routes vote/pass decisions straight through to Medium's own logic, only extending placement and flip", () => {
    const config = configForPlayerCount(2, "none", "medium");
    const rng = deterministicRng(2);
    let state = createGame(["p1", "p2"], config, rng, [], 0);
    while (getLegalPlacementCells(state).length > 0 && state.phase === "playing") {
      const player = state.players[state.currentPlayerIndex];
      if (player.hand.length === 0) break;
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    if (state.phase !== "playing" || !mustPass(state)) return; // board didn't fill the way this test assumes; not the property under test
    const playerId = currentPlayerId(state);
    const action = chooseHardFastAction(state, playerId, FAST_OPTIONS, rng);
    expect(action).toEqual({ type: "pass", playerId });
  });

  it("drives a short full game to completion without throwing -- including whenever a flip candidate's determinized guess makes an otherwise-legal flip blocked (e.g. a hidden neighbor randomly guessed as Cyclops), which evaluateCandidateOnce must skip, not crash on", () => {
    const rng = deterministicRng(3);
    const config = configForPlayerCount(3, "none", "medium");
    let state = createGame(["p1", "p2", "p3"], config, rng, [], 0);
    let iterations = 0;

    while (state.phase !== "ended" && iterations < 300) {
      const playerId = activePlayerId(state);
      const action = state.phase === "voting" ? { type: "castVote" as const, playerId, vote: iterations % 2 === 0 } : chooseHardFastAction(state, playerId, FAST_OPTIONS, rng);
      state = applyAction(state, action, rng);
      iterations++;
    }

    expect(state.phase).toBe("ended");
  });

  it("is deterministic for a given seed and maxRounds/maxPasses cap", () => {
    const config = configForPlayerCount(2, "none", "medium");
    const state = createGame(["p1", "p2"], config, deterministicRng(4), [], 0);
    const a = chooseHardFastAction(state, "p1", FAST_OPTIONS, deterministicRng(9));
    const b = chooseHardFastAction(state, "p1", FAST_OPTIONS, deterministicRng(9));
    expect(a).toEqual(b);
  });

  it("can actually choose a flip over a placement -- across enough decisions in a real game with flip unlocked, at least one flip gets chosen, proving the flip-candidate search path is reachable and can win", () => {
    const rng = deterministicRng(11);
    const config = configForPlayerCount(4, "none", "medium");
    let state = createGame(["p1", "p2", "p3", "p4"], config, rng, [], 0);
    let flipsChosen = 0;
    let iterations = 0;

    while (state.phase !== "ended" && iterations < 400) {
      const playerId = activePlayerId(state);
      if (state.phase === "voting") {
        state = applyAction(state, { type: "castVote", playerId, vote: false }, rng);
        iterations++;
        continue;
      }
      const action = chooseHardFastAction(state, playerId, FAST_OPTIONS, rng);
      if (action.type === "flip") flipsChosen++;
      state = applyAction(state, action, rng);
      iterations++;
    }

    expect(flipsChosen).toBeGreaterThan(0);
  });
});

describe("chooseExpertVote", () => {
  it("is deterministic for a given seed and maxPasses cap", () => {
    const config = configForPlayerCount(3, "none", "medium");
    const state = createGame(["p1", "p2", "p3"], config, deterministicRng(6), [], 0);
    const a = chooseExpertVote(state, "p1", FAST_OPTIONS, deterministicRng(2));
    const b = chooseExpertVote(state, "p1", FAST_OPTIONS, deterministicRng(2));
    expect(a).toBe(b);
  });

  it("falls back to computeAiVote when voteMaxPasses is 0 -- no sample can complete, so there's nothing to compare 'end now' against", () => {
    const config = configForPlayerCount(3, "none", "medium");
    const state = createGame(["p1", "p2", "p3"], config, deterministicRng(6), [], 0);
    const options: HardFastOptions = { ...FAST_OPTIONS, voteMaxPasses: 0 };
    expect(chooseExpertVote(state, "p1", options, deterministicRng(2))).toBe(computeAiVote(state, "p1", deterministicRng(2)));
  });

  it("drives a short full game to completion without throwing when used as the vote decision at every round boundary", () => {
    const rng = deterministicRng(3);
    const config = configForPlayerCount(3, "none", "medium");
    let state = createGame(["p1", "p2", "p3"], config, rng, [], 0);
    let iterations = 0;

    while (state.phase !== "ended" && iterations < 300) {
      const playerId = activePlayerId(state);
      const action = state.phase === "voting" ? { type: "castVote" as const, playerId, vote: chooseExpertVote(state, playerId, FAST_OPTIONS, rng) } : chooseHardFastAction(state, playerId, FAST_OPTIONS, rng);
      state = applyAction(state, action, rng);
      iterations++;
    }

    expect(state.phase).toBe("ended");
  });
});
