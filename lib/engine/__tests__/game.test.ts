import { describe, expect, it } from "vitest";
import { applyAction, createGame } from "../game";
import { getLegalPlacementCells } from "../turns";
import { GameConfig, GameState } from "../types";

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe("createGame", () => {
  it("deals a hand to each player and starts at round 1, player 0's turn", () => {
    const config: GameConfig = {
      boardBounds: { width: 5, height: 3, center: { x: 2, y: 1 } },
      handSize: 7,
      roundCap: 6,
      flipUnlockRound: 2,
      centerEffect: "none",
    minRoundFloor: 1,
    };
    const state = createGame(["p1", "p2"], config, deterministicRng(1));
    expect(state.players[0].hand).toHaveLength(7);
    expect(state.players[1].hand).toHaveLength(7);
    expect(state.round).toBe(1);
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.phase).toBe("playing");
  });
});

describe("applyAction — round-boundary-only endgame (cap)", () => {
  const config: GameConfig = {
    boardBounds: { width: 7, height: 7, center: { x: 3, y: 3 } },
    handSize: 2,
    roundCap: 1,
    flipUnlockRound: 2,
    centerEffect: "none",
    minRoundFloor: 1,
  };

  it("does not end mid-round even though the cap is already met", () => {
    let state = createGame(["p1", "p2"], config, deterministicRng(2));
    const cell = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p1", instanceId: state.players[0].hand[0].instanceId, position: cell });
    expect(state.phase).toBe("playing");
    expect(state.currentPlayerIndex).toBe(1);
    expect(state.round).toBe(1);
  });

  it("ends right after the round boundary, with equal turns for both players", () => {
    let state = createGame(["p1", "p2"], config, deterministicRng(2));
    const cell1 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p1", instanceId: state.players[0].hand[0].instanceId, position: cell1 });
    const cell2 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p2", instanceId: state.players[1].hand[0].instanceId, position: cell2 });

    expect(state.phase).toBe("ended");
    expect(state.result).not.toBeNull();
    expect(state.result?.scores.p1).toBeGreaterThanOrEqual(0);
    expect(state.result?.scores.p2).toBeGreaterThanOrEqual(0);

    const p1Cards = [...state.board.values()].filter((c) => c.ownerId === "p1").length;
    const p2Cards = [...state.board.values()].filter((c) => c.ownerId === "p2").length;
    expect(p1Cards).toBe(1);
    expect(p2Cards).toBe(1);
  });
});

describe("applyAction — board-fill endgame trigger", () => {
  const config: GameConfig = {
    boardBounds: { width: 3, height: 3, center: { x: 1, y: 1 } },
    handSize: 4,
    roundCap: 10,
    flipUnlockRound: 2,
    centerEffect: "none",
    minRoundFloor: 10, // above where the board fills (round 4), so voting doesn't interfere here
  };

  it("ends when the board fills, before the (much higher) round cap", () => {
    let state: GameState = createGame(["p1", "p2"], config, deterministicRng(3));
    let turnsTaken = 0;
    const maxIterations = 20;

    for (let i = 0; i < maxIterations && state.phase === "playing"; i++) {
      const playerIndex = state.currentPlayerIndex;
      const playerId = state.players[playerIndex].id;
      const cells = getLegalPlacementCells(state);
      if (cells.length === 0) {
        state = applyAction(state, { type: "pass", playerId });
      } else {
        const instanceId = state.players[playerIndex].hand[0].instanceId;
        state = applyAction(state, { type: "place", playerId, instanceId, position: cells[0] });
      }
      turnsTaken++;
    }

    expect(state.phase).toBe("ended");
    expect(state.round).toBe(4); // 8 non-center cells / 2 players = 4 rounds
    expect(turnsTaken).toBe(8);

    const p1Cards = [...state.board.values()].filter((c) => c.ownerId === "p1").length;
    const p2Cards = [...state.board.values()].filter((c) => c.ownerId === "p2").length;
    expect(p1Cards).toBe(4);
    expect(p2Cards).toBe(4);
  });
});

describe("applyAction — turn ownership", () => {
  const config: GameConfig = {
    boardBounds: { width: 5, height: 5, center: { x: 2, y: 2 } },
    handSize: 7,
    roundCap: 6,
    flipUnlockRound: 2,
    centerEffect: "none",
    minRoundFloor: 1,
  };

  it("rejects an action from a player who is not current", () => {
    const state = createGame(["p1", "p2"], config, deterministicRng(4));
    expect(() =>
      applyAction(state, { type: "place", playerId: "p2", instanceId: state.players[1].hand[0].instanceId, position: { x: 2, y: 1 } })
    ).toThrow();
  });

  it("rejects any action once the game has ended", () => {
    const smallConfig: GameConfig = { ...config, roundCap: 1, handSize: 1 };
    let state = createGame(["p1", "p2"], smallConfig, deterministicRng(5));
    const cell1 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p1", instanceId: state.players[0].hand[0].instanceId, position: cell1 });
    const cell2 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p2", instanceId: state.players[1].hand[0].instanceId, position: cell2 });
    expect(state.phase).toBe("ended");
    expect(() => applyAction(state, { type: "pass", playerId: "p1" })).toThrow();
  });
});

describe("applyAction — voting", () => {
  const config: GameConfig = {
    boardBounds: { width: 7, height: 7, center: { x: 3, y: 3 } },
    handSize: 4,
    roundCap: 10,
    flipUnlockRound: 2,
    centerEffect: "none",
    minRoundFloor: 1,
  };

  function playRound1(rngForBoundary: () => number) {
    let state = createGame(["human", "bot"], config, deterministicRng(6), ["bot"]);
    const cell1 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "human", instanceId: state.players[0].hand[0].instanceId, position: cell1 });
    const cell2 = getLegalPlacementCells(state)[0];
    // round boundary: this is the action whose rng decides the AI's vote.
    state = applyAction(
      state,
      { type: "place", playerId: "bot", instanceId: state.players[1].hand[0].instanceId, position: cell2 },
      rngForBoundary
    );
    return state;
  }

  it("opens a vote at the round boundary once the min-round floor is met, with the AI's vote pre-filled", () => {
    const state = playRound1(() => 0.01); // well under the round-1 probability (1/10) -> AI votes yes
    expect(state.phase).toBe("voting");
    expect(state.votes.bot).toBe(true);
    expect(state.votes.human).toBeUndefined();
    expect(state.round).toBe(1); // not incremented yet -- vote is still pending
  });

  it("does not open a vote before the min-round floor", () => {
    const belowFloorConfig: GameConfig = { ...config, minRoundFloor: 5 };
    let state = createGame(["human", "bot"], belowFloorConfig, deterministicRng(6), ["bot"]);
    const cell1 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "human", instanceId: state.players[0].hand[0].instanceId, position: cell1 });
    const cell2 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "bot", instanceId: state.players[1].hand[0].instanceId, position: cell2 });
    expect(state.phase).toBe("playing");
    expect(state.round).toBe(2);
  });

  it("ends the game once all players vote yes (2p consensus)", () => {
    let state = playRound1(() => 0.01); // AI votes yes
    state = applyAction(state, { type: "castVote", playerId: "human", vote: true });
    expect(state.phase).toBe("ended");
    expect(state.result).not.toBeNull();
  });

  it("continues (tie) if votes split, resetting votes and advancing the round", () => {
    let state = playRound1(() => 0.01); // AI votes yes
    state = applyAction(state, { type: "castVote", playerId: "human", vote: false });
    expect(state.phase).toBe("playing");
    expect(state.votes).toEqual({});
    expect(state.round).toBe(2);
    expect(state.currentPlayerIndex).toBe(0);
  });

  it("continues if the AI itself voted no", () => {
    let state = playRound1(() => 0.99); // well over 1/10 -> AI votes no
    expect(state.votes.bot).toBe(false);
    state = applyAction(state, { type: "castVote", playerId: "human", vote: true });
    expect(state.phase).toBe("playing");
    expect(state.round).toBe(2);
  });

  it("rejects casting a vote when no vote is in progress", () => {
    const state = createGame(["human", "bot"], config, deterministicRng(6), ["bot"]);
    expect(() => applyAction(state, { type: "castVote", playerId: "human", vote: true })).toThrow();
  });

  it("rejects voting twice", () => {
    const state = playRound1(() => 0.99); // AI votes no, human still pending
    expect(() => applyAction(state, { type: "castVote", playerId: "bot", vote: true })).toThrow();
  });
});
