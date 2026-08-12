import { describe, expect, it } from "vitest";
import { chooseRandomAiAction } from "../randomAi";
import { applyAction, createGame, DEFAULT_2P_CONFIG } from "../../engine/game";
import { currentPlayerId } from "../../engine/turns";
import { GameConfig, GameState } from "../../engine/types";

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** Whoever has a decision to make right now: the current turn player, or (during a
 * vote) the next player who hasn't cast one yet. */
function activePlayerId(state: GameState): string {
  if (state.phase === "voting") {
    const pending = state.players.find((p) => !(p.id in state.votes));
    if (!pending) throw new Error("no pending voter, but phase is still 'voting'");
    return pending.id;
  }
  return currentPlayerId(state);
}

function playFullAiGame(config: GameConfig, seed: number, maxIterations = 500): GameState {
  const rng = deterministicRng(seed);
  let state = createGame(["p1", "p2"], config, rng);
  let iterations = 0;

  while (state.phase !== "ended" && iterations < maxIterations) {
    const playerId = activePlayerId(state);
    const action = chooseRandomAiAction(state, playerId, rng);
    // applyAction throws on any illegal action -- that's the property under test.
    state = applyAction(state, action, rng);
    iterations++;
  }

  return state;
}

describe("chooseRandomAiAction", () => {
  it("never proposes an illegal action, across many seeded games on the default 2p config", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const finalState = playFullAiGame(DEFAULT_2P_CONFIG, seed);
      expect(finalState.phase).toBe("ended");
      expect(finalState.result).not.toBeNull();
    }
  });

  it("never proposes an illegal action on a larger board with a higher round cap", () => {
    const config: GameConfig = {
      boardBounds: { width: 7, height: 5, center: { x: 3, y: 2 } },
      handSize: 6,
      roundCap: 6,
      flipUnlockRound: 2,
      centerEffect: "none",
      minRoundFloor: 1,
      playerCount: 2,
      aiDifficulty: "medium",
    };
    for (let seed = 1; seed <= 10; seed++) {
      const finalState = playFullAiGame(config, seed);
      expect(finalState.phase).toBe("ended");
    }
  });

  it("respects turn ownership: throws if asked to act out of turn", () => {
    const state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, deterministicRng(1));
    expect(() => chooseRandomAiAction(state, "p2", deterministicRng(1))).toThrow();
  });

  it("uses at most one flip per turn across a full game", () => {
    const rng = deterministicRng(7);
    let state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, rng);
    let iterations = 0;
    while (state.phase !== "ended" && iterations < 500) {
      const playerId = activePlayerId(state);
      const before = state.hasFlippedThisTurn;
      const action = chooseRandomAiAction(state, playerId, rng);
      if (action.type === "flip") {
        expect(before).toBe(false);
      }
      state = applyAction(state, action, rng);
      iterations++;
    }
    expect(state.phase).toBe("ended");
  });

  it("casts a vote when one is in progress, and never votes twice", () => {
    const rng = deterministicRng(9);
    let state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, rng);
    let sawAVote = false;
    let iterations = 0;
    while (state.phase !== "ended" && iterations < 500) {
      if (state.phase === "voting") sawAVote = true;
      const playerId = activePlayerId(state);
      const action = chooseRandomAiAction(state, playerId, rng);
      state = applyAction(state, action, rng);
      iterations++;
    }
    expect(state.phase).toBe("ended");
    expect(sawAVote).toBe(true);
  });
});
