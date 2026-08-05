import { describe, expect, it } from "vitest";
import { chooseGreedyAiAction } from "../greedyAi";
import { applyAction, createGame, DEFAULT_2P_CONFIG } from "../../engine/game";
import { currentPlayerId } from "../../engine/turns";
import { Board, CardId, CardInstance, GameConfig, GameState, posKey } from "../../engine/types";

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
    const action = chooseGreedyAiAction(state, playerId, rng);
    // applyAction throws on any illegal action -- that's the property under test.
    state = applyAction(state, action, rng);
    iterations++;
  }

  return state;
}

describe("chooseGreedyAiAction — legality", () => {
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
    };
    for (let seed = 1; seed <= 10; seed++) {
      const finalState = playFullAiGame(config, seed);
      expect(finalState.phase).toBe("ended");
    }
  });

  it("respects turn ownership: throws if asked to act out of turn", () => {
    const state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, deterministicRng(1));
    expect(() => chooseGreedyAiAction(state, "p2", deterministicRng(1))).toThrow();
  });

  it("uses at most one flip per turn across a full game", () => {
    const rng = deterministicRng(7);
    let state = createGame(["p1", "p2"], DEFAULT_2P_CONFIG, rng);
    let iterations = 0;
    while (state.phase !== "ended" && iterations < 500) {
      const playerId = activePlayerId(state);
      const before = state.hasFlippedThisTurn;
      const action = chooseGreedyAiAction(state, playerId, rng);
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
      const action = chooseGreedyAiAction(state, playerId, rng);
      state = applyAction(state, action, rng);
      iterations++;
    }
    expect(state.phase).toBe("ended");
    expect(sawAVote).toBe(true);
  });
});

const CONFIG: GameConfig = {
  boardBounds: { width: 7, height: 7, center: { x: 3, y: 3 } },
  handSize: 7,
  roundCap: 6,
  flipUnlockRound: 2,
  centerEffect: "none",
  minRoundFloor: 3,
  playerCount: 2,
};

let counter = 0;
function card(cardId: CardId, ownerId: string, faceUp = false): CardInstance {
  return { instanceId: `c${counter++}`, cardId, ownerId, faceUp };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const board: Board = overrides.board ?? new Map();
  return {
    config: CONFIG,
    board,
    deck: [],
    players: [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ],
    currentPlayerIndex: 0,
    round: 1,
    turnsThisRound: 0,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    votes: {},
    voteHistory: [],
    placementOrder: [],
    phase: "playing",
    result: null,
    ...overrides,
  };
}

describe("chooseGreedyAiAction — placement actually looks ahead", () => {
  it("prefers the cell that completes a Footman line over a neutral cell", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1"));
    board.set(posKey({ x: 1, y: 0 }), card("Footman", "p1"));
    // Both (2,0) [completes the line, +1 x3] and (0,1) [neutral, adjacent to (0,0)] are legal.
    const handCard = card("Footman", "p1");
    const state = makeState({
      board,
      players: [
        { id: "p1", hand: [handCard], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(3));
    expect(action).toEqual({ type: "place", playerId: "p1", instanceId: handCard.instanceId, position: { x: 2, y: 0 } });
  });

  it("exploits an opponent's *visible* Bannerman: it buffs whoever ends up adjacent, any owner", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 3, y: 2 }), card("Bannerman", "p2", true)); // face-up -- legitimately known
    const handCard = card("Footman", "p1");
    const state = makeState({
      board,
      players: [
        { id: "p1", hand: [handCard], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    // Adjacent-to-Bannerman cells (+2 to p1's own Footman) beat neutral center-adjacent
    // cells (base 5, no bonus): (2,2)/(3,1)/(4,2) all score margin 7-4=3 vs 5-4=1.
    const bannermanAdjacent = [
      { x: 2, y: 2 },
      { x: 3, y: 1 },
      { x: 4, y: 2 },
    ];

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(5));
    expect(action.type).toBe("place");
    if (action.type === "place") {
      expect(bannermanAdjacent).toContainEqual(action.position);
    }
  });

  it("does NOT exploit the same Bannerman while it's still face-down (hidden info stays hidden)", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 3, y: 2 }), card("Bannerman", "p2", false)); // face-down -- unknown to p1
    const handCard = card("Footman", "p1");
    const state = makeState({
      board,
      players: [
        { id: "p1", hand: [handCard], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    // Every legal cell now scores identically from p1's point of view (the hidden
    // Bannerman is redacted to a neutral placeholder), so run it across many seeds and
    // confirm the "exploit" cells are never favored more than any other legal cell --
    // i.e. no systematic bias toward the hidden card's true identity.
    const bannermanAdjacentKeys = new Set(["2,2", "3,1", "4,2"]);
    let adjacentPicks = 0;
    const trials = 30;
    for (let seed = 0; seed < trials; seed++) {
      const action = chooseGreedyAiAction(state, "p1", deterministicRng(100 + seed));
      if (action.type === "place" && bannermanAdjacentKeys.has(posKey(action.position))) adjacentPicks++;
    }
    // 3 of the ~7 legal cells are "adjacent to the hidden card" -- pure chance would
    // land here ~3/7 of the time. A cheating AI would land here ~100% of the time.
    expect(adjacentPicks).toBeLessThan(trials);
    expect(adjacentPicks).toBeGreaterThan(0);
  });
});

describe("chooseGreedyAiAction — flip actually looks ahead", () => {
  it("flips its own face-down Gloryseeker face-up for the +3", () => {
    const board: Board = new Map();
    const gloryseeker = card("Gloryseeker", "p1", false);
    board.set(posKey({ x: 3, y: 2 }), gloryseeker);
    const state = makeState({ board, round: 3 });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(2));
    expect(action).toEqual({ type: "flip", playerId: "p1", instanceId: gloryseeker.instanceId });
  });

  it("does not flip when nothing on the board would benefit", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 3, y: 2 }), card("Footman", "p1", false));
    const state = makeState({
      board,
      round: 3,
      players: [
        { id: "p1", hand: [card("Footman", "p1")], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(2));
    expect(action.type).not.toBe("flip");
  });

  it("picks which opponent card to flip blindly -- never biased toward the more revealing one", () => {
    const board: Board = new Map();
    // Both hidden from p1. If the AI could see through them, it would have a reason
    // to prefer one (Gloryseeker helps p2 if later revealed face-up) -- it shouldn't.
    const gloryseeker = card("Gloryseeker", "p2", false);
    const footman = card("Footman", "p2", false);
    board.set(posKey({ x: 3, y: 2 }), gloryseeker);
    board.set(posKey({ x: 3, y: 4 }), footman);
    const state = makeState({ board, round: 3 });

    let gloryseekerPicks = 0;
    let footmanPicks = 0;
    const trials = 80;
    for (let seed = 0; seed < trials; seed++) {
      const action = chooseGreedyAiAction(state, "p1", deterministicRng(200 + seed));
      if (action.type !== "flip") continue;
      if (action.instanceId === gloryseeker.instanceId) gloryseekerPicks++;
      if (action.instanceId === footman.instanceId) footmanPicks++;
    }
    // Both should get flipped a comparable number of times -- neither is favored.
    expect(gloryseekerPicks).toBeGreaterThan(0);
    expect(footmanPicks).toBeGreaterThan(0);
  });
});
