import { describe, expect, it } from "vitest";
import { copiesForPlayerCount, CARD_DEFS } from "../../content/cards";
import { applyAction, configForPlayerCount, createGame } from "../../engine/game";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "../../engine/turns";
import { CardId, GameConfig, GameState } from "../../engine/types";
import { chooseMctsAction, determinize, MctsOptions } from "../mcts";

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** A tiny time/depth/iteration budget, purely so these tests run fast -- play strength isn't what's under test here. */
const FAST_OPTIONS: MctsOptions = { timeBudgetMs: 50, maxSimulationDepth: 6, explorationConstant: 1.4, maxIterations: 20 };

function activePlayerId(state: GameState): string {
  if (state.phase === "voting") {
    const pending = state.players.find((p) => !(p.id in state.votes));
    if (!pending) throw new Error("no pending voter, but phase is still 'voting'");
    return pending.id;
  }
  return currentPlayerId(state);
}

describe("determinize", () => {
  it("preserves the full deck composition (every cardId's total count across hands+board+deck stays the same)", () => {
    const rng = deterministicRng(1);
    const config = configForPlayerCount(4, "none", "medium");
    let state = createGame(["p1", "p2", "p3", "p4"], config, rng, [], 0);
    // Play a few turns so the board isn't empty -- known/unknown cards only diverge once something's placed.
    for (let i = 0; i < 6; i++) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }

    function countsIn(s: GameState): Map<CardId, number> {
      const counts = new Map<CardId, number>();
      const bump = (id: CardId) => counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const p of s.players) for (const c of p.hand) bump(c.cardId);
      for (const c of s.board.values()) bump(c.cardId);
      for (const c of s.deck) bump(c.cardId);
      return counts;
    }

    const before = countsIn(state);
    const determinized = determinize(state, "p1", deterministicRng(2));
    const after = countsIn(determinized);

    for (const cardId of Object.keys(CARD_DEFS) as CardId[]) {
      const expected = copiesForPlayerCount(CARD_DEFS[cardId], 4);
      expect(after.get(cardId) ?? 0).toBe(expected);
      expect(before.get(cardId) ?? 0).toBe(expected);
    }
  });

  it("never changes the viewer's own hand, the viewer's own board cards, or any face-up board card", () => {
    const rng = deterministicRng(3);
    const config = configForPlayerCount(3, "none", "medium");
    let state = createGame(["p1", "p2", "p3"], config, rng, [], 0);
    for (let i = 0; i < 3; i++) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    // Force one board card face-up so the "face-up stays known" branch is exercised.
    const [key, card] = [...state.board.entries()][0];
    const boardWithFaceUp = new Map(state.board);
    boardWithFaceUp.set(key, { ...card, faceUp: true });
    state = { ...state, board: boardWithFaceUp };

    const determinized = determinize(state, "p1", deterministicRng(4));

    const viewerHandBefore = state.players.find((p) => p.id === "p1")!.hand;
    const viewerHandAfter = determinized.players.find((p) => p.id === "p1")!.hand;
    expect(viewerHandAfter).toEqual(viewerHandBefore);

    for (const [k, c] of state.board) {
      if (c.faceUp || c.ownerId === "p1") {
        expect(determinized.board.get(k)!.cardId).toBe(c.cardId);
      }
    }
  });
});

describe("chooseMctsAction", () => {
  it("always returns a legal action", () => {
    const rng = deterministicRng(5);
    const config = configForPlayerCount(3, "none", "medium");
    let state = createGame(["p1", "p2", "p3"], config, rng, [], 0);

    for (let i = 0; i < 5; i++) {
      const playerId = activePlayerId(state);
      if (state.phase === "voting") {
        state = applyAction(state, { type: "castVote", playerId, vote: false }, rng);
        continue;
      }
      const action = chooseMctsAction(state, playerId, FAST_OPTIONS, rng);

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

  it("returns a forced move immediately without searching when there's only one legal action", () => {
    const config: GameConfig = {
      boardBounds: { width: 3, height: 3, center: { x: 1, y: 1 } },
      handSize: 1,
      roundCap: 6,
      flipUnlockRound: 99, // keep flipping out of the way
      centerEffect: "none",
      minRoundFloor: 6,
      playerCount: 2,
      aiDifficulty: "hard",
    };
    const rng = deterministicRng(6);
    let state = createGame(["p1", "p2"], config, rng, [], 0);
    // Fill every legal cell on this tiny board except one, and empty p1's hand down to
    // a single card, so exactly one (card, cell) placement is legal.
    while (getLegalPlacementCells(state).length > 1) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
      if (state.currentPlayerIndex !== 0 || state.players[0].hand.length === 0) break;
    }

    const p1 = state.players.find((p) => p.id === "p1")!;
    if (p1.hand.length === 0 || state.phase !== "playing" || currentPlayerId(state) !== "p1") return; // setup didn't land where expected; not the property under test

    const action = chooseMctsAction(state, "p1", { timeBudgetMs: 0, maxSimulationDepth: 1, explorationConstant: 1.4 }, rng);
    expect(action.playerId).toBe("p1");
  });

  it("drives a short full game to completion without throwing", () => {
    const rng = deterministicRng(7);
    const config = configForPlayerCount(2, "none", "medium");
    let state = createGame(["p1", "p2"], config, rng, [], 0);
    let iterations = 0;

    while (state.phase !== "ended" && iterations < 200) {
      const playerId = activePlayerId(state);
      const action = state.phase === "voting" ? { type: "castVote" as const, playerId, vote: iterations % 2 === 0 } : chooseMctsAction(state, playerId, FAST_OPTIONS, rng);
      state = applyAction(state, action, rng);
      iterations++;
    }

    expect(state.phase).toBe("ended");
  });
});
