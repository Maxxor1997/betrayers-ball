import { describe, expect, it } from "vitest";
import { applyFlip, applyPass, applyPlace, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "../turns";
import { Board, CardId, CardInstance, GameConfig, GameState, posKey } from "../types";

const CONFIG: GameConfig = {
  boardBounds: { width: 5, height: 5, center: { x: 2, y: 2 } },
  handSize: 7,
  roundCap: 6,
  flipUnlockRound: 2,
  centerEffect: "none",
  minRoundFloor: 1,
  playerCount: 2,
};

let counter = 0;
function handCard(cardId: CardId, ownerId: string): CardInstance {
  return { instanceId: `h${counter++}`, cardId, ownerId, faceUp: false };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const board: Board = overrides.board ?? new Map();
  return {
    config: CONFIG,
    board,
    deck: [],
    players: [
      { id: "p1", hand: [handCard("Footman", "p1")], isAI: false },
      { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
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

describe("getLegalPlacementCells / applyPlace", () => {
  it("on an empty board, only cells adjacent to center are legal", () => {
    const state = makeState();
    const cells = getLegalPlacementCells(state).map(posKey).sort();
    expect(cells.sort()).toEqual(["1,2", "2,1", "2,3", "3,2"].sort());
  });

  it("rejects placement on the center tile", () => {
    const state = makeState();
    expect(() =>
      applyPlace(state, { type: "place", playerId: "p1", instanceId: state.players[0].hand[0].instanceId, position: { x: 2, y: 2 } })
    ).toThrow();
  });

  it("rejects placement not adjacent to anything", () => {
    const state = makeState();
    expect(() =>
      applyPlace(state, { type: "place", playerId: "p1", instanceId: state.players[0].hand[0].instanceId, position: { x: 4, y: 4 } })
    ).toThrow();
  });

  it("rejects placement by a player who is not current", () => {
    const state = makeState();
    expect(() =>
      applyPlace(state, { type: "place", playerId: "p2", instanceId: state.players[1].hand[0].instanceId, position: { x: 2, y: 1 } })
    ).toThrow();
  });

  it("moves the card from hand to board and removes it from hand", () => {
    const state = makeState();
    const cardId = state.players[0].hand[0].instanceId;
    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: cardId, position: { x: 2, y: 1 } });
    expect(next.players[0].hand).toHaveLength(0);
    expect(next.board.get("2,1")?.instanceId).toBe(cardId);
  });

  it("appends to placementOrder in the order cards are placed", () => {
    const state = makeState();
    const cardId = state.players[0].hand[0].instanceId;
    expect(state.placementOrder).toEqual([]);
    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: cardId, position: { x: 2, y: 1 } });
    expect(next.placementOrder).toEqual([cardId]);
  });

  it("forces Giant to be placed face-up", () => {
    const state = makeState({
      players: [
        { id: "p1", hand: [handCard("Giant", "p1")], isAI: false },
        { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
      ],
    });
    const cardId = state.players[0].hand[0].instanceId;
    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: cardId, position: { x: 2, y: 1 } });
    expect(next.board.get("2,1")?.faceUp).toBe(true);
  });
});

describe("getLegalPlacementCells / applyPlace — The Free Cities", () => {
  const FREE_CITIES_CONFIG: GameConfig = { ...CONFIG, centerEffect: "freeCities" };

  it("makes every empty non-center cell legal, even on an empty board", () => {
    const state = makeState({ config: FREE_CITIES_CONFIG });
    const cells = getLegalPlacementCells(state).map(posKey);
    expect(cells).toContain("0,0"); // far corner, not adjacent to anything
    expect(cells).not.toContain("2,2"); // center still excluded
  });

  it("allows placing on a cell not adjacent to anything", () => {
    const state = makeState({ config: FREE_CITIES_CONFIG });
    const cardId = state.players[0].hand[0].instanceId;
    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: cardId, position: { x: 0, y: 0 } });
    expect(next.board.get("0,0")?.instanceId).toBe(cardId);
  });
});

describe("flipping", () => {
  it("is locked before flipUnlockRound", () => {
    const board: Board = new Map();
    board.set("2,1", handCard("Footman", "p1"));
    const state = makeState({ board, round: 1 });
    expect(getLegalFlipTargets(state)).toHaveLength(0);
    const target = state.board.get("2,1")!;
    expect(() => applyFlip(state, { type: "flip", playerId: "p1", instanceId: target.instanceId })).toThrow();
  });

  it("allows flipping any face-down card, any owner, from round 2", () => {
    const board: Board = new Map();
    const opponentCard = handCard("Footman", "p2");
    board.set("2,1", opponentCard);
    const state = makeState({ board, round: 2 });
    expect(getLegalFlipTargets(state)).toHaveLength(1);
    const next = applyFlip(state, { type: "flip", playerId: "p1", instanceId: opponentCard.instanceId });
    expect(next.board.get("2,1")?.faceUp).toBe(true);
    expect(next.hasFlippedThisTurn).toBe(true);
  });

  it("allows at most one flip per turn", () => {
    const board: Board = new Map();
    board.set("2,1", handCard("Footman", "p1"));
    board.set("2,3", handCard("Footman", "p1"));
    const state = makeState({ board, round: 2 });
    const c1 = state.board.get("2,1")!;
    const c2 = state.board.get("2,3")!;
    const next = applyFlip(state, { type: "flip", playerId: "p1", instanceId: c1.instanceId });
    expect(() => applyFlip(next, { type: "flip", playerId: "p1", instanceId: c2.instanceId })).toThrow();
  });

  it("rejects flipping an already-face-up card", () => {
    const board: Board = new Map();
    board.set("2,1", { ...handCard("Footman", "p1"), faceUp: true });
    const state = makeState({ board, round: 2 });
    const target = state.board.get("2,1")!;
    expect(() => applyFlip(state, { type: "flip", playerId: "p1", instanceId: target.instanceId })).toThrow();
  });
});

describe("flipping — Shadowlands", () => {
  // Shadowlands no longer gates the flip action at all -- it's a scoring effect now
  // (face-down +1 / face-up -1, see resolution.test.ts), so flipping should follow the
  // plain default gate (round >= flipUnlockRound), same as "none".
  const SHADOWLANDS_CONFIG: GameConfig = { ...CONFIG, centerEffect: "shadowlands" };

  function stateAtRound(round: number): GameState {
    const board: Board = new Map();
    board.set("2,1", handCard("Footman", "p1"));
    return makeState({ board, round, config: SHADOWLANDS_CONFIG });
  }

  it("allows flipping from flipUnlockRound on, every round -- not just 2, 4, 6", () => {
    for (const round of [2, 3, 4, 5, 6]) {
      expect(getLegalFlipTargets(stateAtRound(round))).toHaveLength(1);
    }
  });

  it("blocks flipping before flipUnlockRound", () => {
    const state = stateAtRound(1);
    expect(getLegalFlipTargets(state)).toHaveLength(0);
    const target = state.board.get("2,1")!;
    expect(() => applyFlip(state, { type: "flip", playerId: "p1", instanceId: target.instanceId })).toThrow();
  });

  it("still respects the once-per-turn limit on an unlocked round", () => {
    const board: Board = new Map();
    board.set("2,1", handCard("Footman", "p1"));
    board.set("2,3", handCard("Footman", "p1"));
    const state = makeState({ board, round: 2, config: SHADOWLANDS_CONFIG });
    const c1 = state.board.get("2,1")!;
    const c2 = state.board.get("2,3")!;
    const next = applyFlip(state, { type: "flip", playerId: "p1", instanceId: c1.instanceId });
    expect(() => applyFlip(next, { type: "flip", playerId: "p1", instanceId: c2.instanceId })).toThrow();
  });
});

describe("mustPass / applyPass", () => {
  it("is false when a legal move exists", () => {
    const state = makeState();
    expect(mustPass(state)).toBe(false);
  });

  it("is true when the player's hand is empty", () => {
    const state = makeState({
      players: [
        { id: "p1", hand: [], isAI: false },
        { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
      ],
    });
    expect(mustPass(state)).toBe(true);
  });

  it("applyPass throws if the player actually has a legal move", () => {
    const state = makeState();
    expect(() => applyPass(state, "p1")).toThrow();
  });

  it("applyPass succeeds when no legal move exists", () => {
    const state = makeState({
      players: [
        { id: "p1", hand: [], isAI: false },
        { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
      ],
    });
    expect(() => applyPass(state, "p1")).not.toThrow();
  });
});

describe("placing — Truthseeker", () => {
  it("immediately flips all adjacent face-down cards, any owner, but not itself", () => {
    const board: Board = new Map();
    const neighbor1 = handCard("Footman", "p1");
    const neighbor2 = handCard("Warlord", "p2");
    board.set("2,0", neighbor1);
    board.set("1,1", neighbor2);
    const truthseeker = handCard("Truthseeker", "p1");
    const state = makeState({
      board,
      players: [
        { id: "p1", hand: [truthseeker], isAI: false },
        { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
      ],
    });

    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: truthseeker.instanceId, position: { x: 2, y: 1 } });

    expect(next.board.get("2,0")?.faceUp).toBe(true);
    expect(next.board.get("1,1")?.faceUp).toBe(true);
    expect(next.board.get("2,1")?.faceUp).toBe(true); // Truthseeker is always placed face-up
  });

  it("leaves already-face-up neighbors untouched", () => {
    const board: Board = new Map();
    const alreadyUp = { ...handCard("Gloryseeker", "p2"), faceUp: true };
    board.set("2,0", alreadyUp);
    const truthseeker = handCard("Truthseeker", "p1");
    const state = makeState({
      board,
      players: [
        { id: "p1", hand: [truthseeker], isAI: false },
        { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
      ],
    });
    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: truthseeker.instanceId, position: { x: 2, y: 1 } });
    expect(next.board.get("2,0")).toEqual(alreadyUp);
  });

  it("does not consume the turn's normal flip allowance", () => {
    const board: Board = new Map();
    board.set("2,0", handCard("Footman", "p2"));
    const truthseeker = handCard("Truthseeker", "p1");
    const state = makeState({
      board,
      round: 3,
      players: [
        { id: "p1", hand: [truthseeker], isAI: false },
        { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
      ],
    });
    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: truthseeker.instanceId, position: { x: 2, y: 1 } });
    expect(next.hasFlippedThisTurn).toBe(false);
  });

  it("fires even when round 1 would normally lock flipping entirely", () => {
    const board: Board = new Map();
    board.set("2,0", handCard("Footman", "p2"));
    const truthseeker = handCard("Truthseeker", "p1");
    const state = makeState({
      board,
      round: 1,
      players: [
        { id: "p1", hand: [truthseeker], isAI: false },
        { id: "p2", hand: [handCard("Footman", "p2")], isAI: false },
      ],
    });
    const next = applyPlace(state, { type: "place", playerId: "p1", instanceId: truthseeker.instanceId, position: { x: 2, y: 1 } });
    expect(next.board.get("2,0")?.faceUp).toBe(true);
  });
});
