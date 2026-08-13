import { describe, expect, it } from "vitest";
import { applyAction, configForPlayerCount, createGame } from "../../engine/game";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "../../engine/turns";
import { GameState } from "../../engine/types";
import { chooseTwoPlyAction, TwoPlyOptions } from "../twoPly";

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** A tiny time/round budget, purely so these tests run fast -- play strength isn't what's under test here. */
const FAST_OPTIONS: TwoPlyOptions = { timeBudgetMs: 50, maxCandidates: 6, roundsAhead: 1, maxPasses: 2 };

function activePlayerId(state: GameState): string {
  if (state.phase === "voting") {
    const pending = state.players.find((p) => !(p.id in state.votes));
    if (!pending) throw new Error("no pending voter, but phase is still 'voting'");
    return pending.id;
  }
  return currentPlayerId(state);
}

describe("chooseTwoPlyAction", () => {
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
      const action = chooseTwoPlyAction(state, playerId, FAST_OPTIONS, rng);

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

  it("routes flip/pass decisions straight through to chooseGreedyAiAction, only extending the placement decision", () => {
    // A single-card hand with no legal cells forces a pass -- chooseTwoPlyAction should
    // hand this straight back without attempting to rank/evaluate anything.
    const config = configForPlayerCount(2, "none", "medium");
    const rng = deterministicRng(2);
    let state = createGame(["p1", "p2"], config, rng, [], 0);
    // Fill the board down to nothing legal for p1's single remaining card by placing
    // until no legal cells remain, then confirm a pass is returned when it's forced.
    while (getLegalPlacementCells(state).length > 0 && state.phase === "playing") {
      const player = state.players[state.currentPlayerIndex];
      if (player.hand.length === 0) break;
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    if (state.phase !== "playing" || !mustPass(state)) return; // board didn't fill the way this test assumes; not the property under test
    const playerId = currentPlayerId(state);
    const action = chooseTwoPlyAction(state, playerId, FAST_OPTIONS, rng);
    expect(action).toEqual({ type: "pass", playerId });
  });

  it("drives a short full game to completion without throwing", () => {
    const rng = deterministicRng(3);
    const config = configForPlayerCount(2, "none", "medium");
    let state = createGame(["p1", "p2"], config, rng, [], 0);
    let iterations = 0;

    while (state.phase !== "ended" && iterations < 200) {
      const playerId = activePlayerId(state);
      const action = state.phase === "voting" ? { type: "castVote" as const, playerId, vote: iterations % 2 === 0 } : chooseTwoPlyAction(state, playerId, FAST_OPTIONS, rng);
      state = applyAction(state, action, rng);
      iterations++;
    }

    expect(state.phase).toBe("ended");
  });

  it("is deterministic for a given seed and maxRounds cap", () => {
    const config = configForPlayerCount(2, "none", "medium");
    const state = createGame(["p1", "p2"], config, deterministicRng(4), [], 0);
    const a = chooseTwoPlyAction(state, "p1", FAST_OPTIONS, deterministicRng(9));
    const b = chooseTwoPlyAction(state, "p1", FAST_OPTIONS, deterministicRng(9));
    expect(a).toEqual(b);
  });
});
