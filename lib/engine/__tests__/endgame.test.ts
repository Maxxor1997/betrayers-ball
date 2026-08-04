import { describe, expect, it } from "vitest";
import { aiVoteProbability, computeAiVote, computeGameResult, estimateMargin, isBoardFull, isRoundCapHit, shouldEndGame } from "../endgame";
import { Board, BoardBounds, CardInstance, GameConfig, GameState, posKey } from "../types";

const BOUNDS: BoardBounds = { width: 3, height: 3, center: { x: 1, y: 1 } };

let counter = 0;
function card(cardId: CardInstance["cardId"], ownerId: string, faceUp = false): CardInstance {
  return { instanceId: `c${counter++}`, cardId, ownerId, faceUp };
}

const MARGIN_CONFIG: GameConfig = {
  boardBounds: BOUNDS,
  handSize: 7,
  roundCap: 6,
  flipUnlockRound: 2,
  centerEffect: "none",
  minRoundFloor: 3,
};

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    config: MARGIN_CONFIG,
    board: new Map(),
    players: [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ],
    currentPlayerIndex: 0,
    round: 1,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    votes: {},
    placementOrder: [],
    phase: "playing",
    result: null,
    ...overrides,
  };
}

describe("isRoundCapHit", () => {
  it("is false below the cap and true at/above it", () => {
    expect(isRoundCapHit(5, 6)).toBe(false);
    expect(isRoundCapHit(6, 6)).toBe(true);
    expect(isRoundCapHit(7, 6)).toBe(true);
  });
});

describe("isBoardFull", () => {
  it("is false on an empty board", () => {
    expect(isBoardFull(new Map(), BOUNDS)).toBe(false);
  });

  it("is true once every non-center cell is occupied", () => {
    const board: Board = new Map();
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        if (x === 1 && y === 1) continue;
        board.set(posKey({ x, y }), card("Footman", "p1"));
      }
    }
    expect(isBoardFull(board, BOUNDS)).toBe(true);
  });
});

describe("shouldEndGame", () => {
  it("triggers on cap even with an empty board", () => {
    expect(shouldEndGame(new Map(), BOUNDS, 6, 6)).toBe(true);
  });

  it("does not trigger below cap on a non-full board", () => {
    expect(shouldEndGame(new Map(), BOUNDS, 3, 6)).toBe(false);
  });
});

describe("aiVoteProbability", () => {
  it("increases linearly with round, reaching certainty at the cap", () => {
    expect(aiVoteProbability(1, 10)).toBeCloseTo(0.1);
    expect(aiVoteProbability(5, 10)).toBeCloseTo(0.5);
    expect(aiVoteProbability(10, 10)).toBe(1);
  });

  it("never exceeds 1 past the cap", () => {
    expect(aiVoteProbability(12, 10)).toBe(1);
  });
});

describe("computeGameResult", () => {
  it("sums owned card values and picks the highest as winner", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1")); // 5
    board.set(posKey({ x: 0, y: 1 }), card("Giant", "p2")); // 6
    const result = computeGameResult(board, BOUNDS, 3, ["p1", "p2"]);
    expect(result.scores).toEqual({ p1: 5, p2: 6 });
    expect(result.winnerIds).toEqual(["p2"]);
  });

  it("defaults a player with no cards to score 0", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1"));
    const result = computeGameResult(board, BOUNDS, 3, ["p1", "p2"]);
    expect(result.scores.p2).toBe(0);
  });

  it("shared win: ties produce multiple winnerIds", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1")); // 5
    board.set(posKey({ x: 0, y: 1 }), card("Footman", "p2")); // 5
    const result = computeGameResult(board, BOUNDS, 3, ["p1", "p2"]);
    expect(result.winnerIds.sort()).toEqual(["p1", "p2"]);
  });
});

describe("estimateMargin — fair, per-viewer evaluation", () => {
  it("values the viewer's own hidden card at its true effect", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p1", false)); // isolated -> true value 9
    expect(estimateMargin(makeState({ board }), "p1")).toBe(9);
  });

  it("does NOT apply an opponent's hidden card's true effect -- uses the neutral placeholder instead", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p2", false)); // hidden from p1; true value would be 9
    // p1 can't see it's an Exile, so it's valued as the Footman placeholder (base 5), not 9.
    expect(estimateMargin(makeState({ board }), "p1")).toBe(0 - 5);
  });

  it("applies the opponent's true effect once the same card is face-up", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p2", true));
    expect(estimateMargin(makeState({ board }), "p1")).toBe(0 - 9);
  });

  it("resolveBoard (ground truth) and estimateMargin (viewer's estimate) genuinely diverge on hidden multi-card effects", () => {
    const board: Board = new Map();
    // 3 isolated, hidden, same-owner Warlords: true value 8-3*2=2 each -> p2 total 6.
    board.set(posKey({ x: 0, y: 0 }), card("Warlord", "p2", false));
    board.set(posKey({ x: 2, y: 0 }), card("Warlord", "p2", false));
    board.set(posKey({ x: 0, y: 2 }), card("Warlord", "p2", false));
    const state = makeState({ board });

    const trueResult = computeGameResult(board, BOUNDS, state.round, ["p1", "p2"]);
    expect(trueResult.scores.p2).toBe(6);

    // p1 can't see any of them are Warlords -- each is estimated as an isolated
    // Footman placeholder (base 5, no line), so p1's own estimate is way off from the
    // ground truth. That's the point: the estimate never leaks the hidden identity.
    expect(estimateMargin(state, "p1")).toBe(0 - 15);
  });
});

describe("computeAiVote", () => {
  it("votes yes when currently ahead by its own fair estimate", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1"));
    board.set(posKey({ x: 0, y: 1 }), card("Footman", "p1"));
    const state = makeState({ board, round: 3 });
    expect(computeAiVote(state, "p1", () => 0.99)).toBe(true); // rng doesn't matter -- clearly ahead
  });

  it("falls back to round-based probability when tied", () => {
    const state = makeState({ round: 3 }); // empty board -> 0-0 tie
    expect(computeAiVote(state, "p1", () => 0.05)).toBe(true); // below aiVoteProbability(3,6)=0.5
    expect(computeAiVote(state, "p1", () => 0.95)).toBe(false);
  });

  it("dampens the probability while behind", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p2"));
    const state = makeState({ board, round: 3 }); // p1 behind (0 vs 5)
    // aiVoteProbability(3,6)=0.5, dampened *0.6=0.3 -- 0.35 clears the tied threshold but not the dampened one.
    expect(computeAiVote(state, "p1", () => 0.35)).toBe(false);
    expect(computeAiVote(state, "p1", () => 0.1)).toBe(true);
  });
});
