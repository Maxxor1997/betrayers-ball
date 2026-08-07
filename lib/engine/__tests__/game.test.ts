import { describe, expect, it } from "vitest";
import { applyAction, configForPlayerCount, createGame } from "../game";
import { getLegalFlipTargets, getLegalPlacementCells } from "../turns";
import { Board, GameConfig, GameState, posKey } from "../types";

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
      playerCount: 2,
    };
    const state = createGame(["p1", "p2"], config, deterministicRng(1));
    expect(state.players[0].hand).toHaveLength(7);
    expect(state.players[1].hand).toHaveLength(7);
    expect(state.round).toBe(1);
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.phase).toBe("playing");
  });

  it("defaults to player 0 going first, but honors an explicit firstPlayerIndex", () => {
    const config: GameConfig = {
      boardBounds: { width: 5, height: 3, center: { x: 2, y: 1 } },
      handSize: 7,
      roundCap: 6,
      flipUnlockRound: 2,
      centerEffect: "none",
      minRoundFloor: 1,
      playerCount: 3,
    };
    const defaultState = createGame(["p1", "p2", "p3"], config, deterministicRng(1));
    expect(defaultState.currentPlayerIndex).toBe(0);

    const chosenState = createGame(["p1", "p2", "p3"], config, deterministicRng(1), [], 2);
    expect(chosenState.currentPlayerIndex).toBe(2);
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
    playerCount: 2,
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
    playerCount: 2,
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
    playerCount: 2,
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
    playerCount: 2,
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

  it("logs a completed round's tally to voteHistory even when it doesn't end the game", () => {
    let state = playRound1(() => 0.01); // AI votes yes
    state = applyAction(state, { type: "castVote", playerId: "human", vote: false });
    expect(state.voteHistory).toEqual([{ round: 1, votes: { bot: true, human: false } }]);
    // votes itself is cleared for the next round, but the history entry persists.
    expect(state.votes).toEqual({});
  });

  it("logs the decisive round's tally to voteHistory when the vote ends the game", () => {
    let state = playRound1(() => 0.01); // AI votes yes
    state = applyAction(state, { type: "castVote", playerId: "human", vote: true });
    expect(state.phase).toBe("ended");
    expect(state.voteHistory).toEqual([{ round: 1, votes: { bot: true, human: true } }]);
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

  // A Jackbox-style display room can have every seat filled with AI (nobody's
  // "human" -- the shared screen itself takes no seat, see DISPLAY_VIEWER_ID). The
  // round-boundary AI-vote loop then fills every player's ballot by itself, with no
  // human left to ever dispatch a castVote action that would trigger the tally --
  // this used to leave the game stuck in "voting" forever.
  it("tallies immediately at a round boundary when every player is AI, instead of waiting on a castVote that will never come", () => {
    let state = createGame(["bot1", "bot2"], config, deterministicRng(6), ["bot1", "bot2"]);
    const cell1 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "bot1", instanceId: state.players[0].hand[0].instanceId, position: cell1 });
    const cell2 = getLegalPlacementCells(state)[0];
    state = applyAction(
      state,
      { type: "place", playerId: "bot2", instanceId: state.players[1].hand[0].instanceId, position: cell2 },
      () => 0.01 // well under the round-1 probability for both AIs -> both vote yes
    );
    // Never observably "voting" from the caller's perspective -- fully tallied (both
    // yes -> ends) within the same place action that crossed the round boundary.
    expect(state.phase).toBe("ended");
    expect(state.voteHistory).toEqual([{ round: 1, votes: { bot1: true, bot2: true } }]);
  });
});

describe("applyAction — centerEffect threads through to a real end-of-game result", () => {
  it("Shadowlands delays flip-unlock by one extra round, enforced through applyAction", () => {
    const config: GameConfig = {
      boardBounds: { width: 7, height: 7, center: { x: 3, y: 3 } },
      handSize: 1,
      roundCap: 6,
      flipUnlockRound: 2,
      centerEffect: "shadowlands",
      minRoundFloor: 10, // keep voting out of the way
      playerCount: 2,
    };
    const board: Board = new Map();
    board.set(posKey({ x: 3, y: 2 }), { instanceId: "c1", cardId: "Footman", ownerId: "p1", faceUp: false });
    const baseState: GameState = {
      config,
      board,
      deck: [],
      players: [
        { id: "p1", hand: [], isAI: false },
        { id: "p2", hand: [], isAI: false },
      ],
      currentPlayerIndex: 0,
      round: 2,
      turnsThisRound: 0,
      passedPlayerIds: new Set(),
      hasFlippedThisTurn: false,
      votes: {},
      voteHistory: [],
      flipHistory: [],
      placementOrder: [],
      phase: "playing",
      result: null,
    };

    // Normally (flipUnlockRound: 2) round 2 would already allow flipping -- Shadowlands
    // pushes that to round 3, threaded through the real reducer, not just isFlipUnlocked directly.
    expect(() => applyAction(baseState, { type: "flip", playerId: "p1", instanceId: "c1" })).toThrow();

    const next = applyAction({ ...baseState, round: 3 }, { type: "flip", playerId: "p1", instanceId: "c1" });
    expect(next.board.get(posKey({ x: 3, y: 2 }))?.faceUp).toBe(true);
  });
});

describe("advanceTurn — round boundary respects a non-zero starting player", () => {
  const config: GameConfig = {
    boardBounds: { width: 7, height: 7, center: { x: 3, y: 3 } },
    handSize: 4,
    roundCap: 10,
    flipUnlockRound: 2,
    centerEffect: "none",
    minRoundFloor: 10, // keep voting out of the way
    playerCount: 3,
  };

  it("does not advance the round (or unlock flipping) until every player, not just the first mover, has acted", () => {
    // p2 (index 1) goes first -- regression test for a bug where the round boundary
    // was detected by currentPlayerIndex wrapping to 0, which fired after a single
    // turn whenever the starting player wasn't index 0.
    let state = createGame(["p1", "p2", "p3"], config, deterministicRng(6), [], 1);
    expect(state.currentPlayerIndex).toBe(1);

    let cell = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p2", instanceId: state.players[1].hand[0].instanceId, position: cell });
    expect(state.round).toBe(1); // still round 1 -- only 1 of 3 players has gone
    expect(state.currentPlayerIndex).toBe(2);
    expect(getLegalFlipTargets(state)).toHaveLength(0); // flip still locked

    cell = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p3", instanceId: state.players[2].hand[0].instanceId, position: cell });
    expect(state.round).toBe(1);
    expect(state.currentPlayerIndex).toBe(0);

    cell = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "p1", instanceId: state.players[0].hand[0].instanceId, position: cell });
    expect(state.round).toBe(2); // now every player has gone -- round advances
    expect(state.currentPlayerIndex).toBe(1); // rotation continues from where it started
  });
});

describe("Reckoning center effect — discard & redraw hands at round 4", () => {
  const config: GameConfig = {
    boardBounds: { width: 9, height: 9, center: { x: 4, y: 4 } },
    handSize: 7,
    roundCap: 10,
    flipUnlockRound: 2,
    centerEffect: "reckoning",
    minRoundFloor: 3,
    playerCount: 2,
  };

  function placeCurrentPlayersFirstCard(state: GameState): GameState {
    const player = state.players[state.currentPlayerIndex];
    const cell = getLegalPlacementCells(state)[0];
    return applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
  }

  function continueAnyPendingVotes(state: GameState): GameState {
    let next = state;
    while (next.phase === "voting") {
      const voter = next.players.find((p) => !(p.id in next.votes))!;
      next = applyAction(next, { type: "castVote", playerId: voter.id, vote: false });
    }
    return next;
  }

  it("redraws every hand at round 4 via the default vote-continue path, preserving hand size but not card identity", () => {
    // No AI players -- every vote is cast explicitly below, so the outcome is fully deterministic.
    let state = createGame(["p1", "p2"], config, deterministicRng(6));

    // Rounds 1 and 2: no vote yet (minRoundFloor is 3).
    for (let i = 0; i < 4; i++) state = placeCurrentPlayersFirstCard(state);
    expect(state.round).toBe(3);

    // Round 3: both placements -- completing it opens a vote (round 3 >= minRoundFloor).
    state = placeCurrentPlayersFirstCard(state);
    state = placeCurrentPlayersFirstCard(state);
    expect(state.phase).toBe("voting");
    expect(state.round).toBe(3); // still round 3 -- the vote hasn't resolved yet

    const beforeHandIds = state.players.map((p) => p.hand.map((c) => c.instanceId).sort());
    const beforeHandSizes = state.players.map((p) => p.hand.length);

    state = continueAnyPendingVotes(state); // both vote to continue -> round 4, Reckoning fires

    expect(state.round).toBe(4);
    const afterHandSizes = state.players.map((p) => p.hand.length);
    const afterHandIds = state.players.map((p) => p.hand.map((c) => c.instanceId).sort());

    expect(afterHandSizes).toEqual(beforeHandSizes);
    expect(afterHandIds).not.toEqual(beforeHandIds);
  });

  it("also redraws via the plain continue path when minRoundFloor is raised above 4", () => {
    const highFloorConfig: GameConfig = { ...config, minRoundFloor: 10 };
    let state = createGame(["p1", "p2"], highFloorConfig, deterministicRng(6));

    // Rounds 1-2 (4 placements) plus p1's round-3 placement.
    for (let i = 0; i < 5; i++) state = placeCurrentPlayersFirstCard(state);
    expect(state.round).toBe(3);

    // p2's round-3 placement is the one that completes the round and triggers Reckoning.
    const p2 = state.players[state.currentPlayerIndex];
    const handWithoutRedraw = p2.hand.slice(1).map((c) => c.instanceId).sort(); // what p2's hand would be if only the placement happened

    state = placeCurrentPlayersFirstCard(state);

    expect(state.round).toBe(4);
    const p2After = state.players.find((p) => p.id === p2.id)!;
    expect(p2After.hand).toHaveLength(4);
    expect(p2After.hand.map((c) => c.instanceId).sort()).not.toEqual(handWithoutRedraw);
  });
});

describe("configForPlayerCount — 2p flip delay", () => {
  it("delays the flip unlock to round 3 for 2 players", () => {
    expect(configForPlayerCount(2).flipUnlockRound).toBe(3);
  });

  it("uses the normal round-2 unlock for every other player count", () => {
    for (const count of [3, 4, 5, 6]) {
      expect(configForPlayerCount(count).flipUnlockRound).toBe(2);
    }
  });

  it("sets playerCount to match", () => {
    expect(configForPlayerCount(2).playerCount).toBe(2);
    expect(configForPlayerCount(4).playerCount).toBe(4);
  });
});
