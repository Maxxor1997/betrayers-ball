import { describe, expect, it } from "vitest";
import { applyAction, configForPlayerCount, createGame } from "../game";
import { getLegalFlipTargets, getLegalPlacementCells, mustPass, offeredCardsFor } from "../turns";
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
      aiDifficulty: "medium",
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
      aiDifficulty: "medium",
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
    aiDifficulty: "medium",
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
    aiDifficulty: "medium",
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
    aiDifficulty: "medium",
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
    aiDifficulty: "medium",
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

  it("uses an injected computeVote override for a round-boundary AI vote auto-fill, instead of the default computeAiVote", () => {
    const alwaysYes = () => true;
    let state = createGame(["human", "bot"], config, deterministicRng(6), ["bot"]);
    const cell1 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "human", instanceId: state.players[0].hand[0].instanceId, position: cell1 });
    const cell2 = getLegalPlacementCells(state)[0];
    // rng of 0.99 would make the DEFAULT computeAiVote vote no (see "continues if the
    // AI itself voted no" above) -- with the override injected, the bot's vote should
    // come from `alwaysYes` instead, proving the injected function actually won.
    state = applyAction(state, { type: "place", playerId: "bot", instanceId: state.players[1].hand[0].instanceId, position: cell2 }, () => 0.99, alwaysYes);
    expect(state.votes.bot).toBe(true);
  });

  it("omitting computeVote entirely still defaults to computeAiVote, unchanged from before the override existed", () => {
    let state = createGame(["human", "bot"], config, deterministicRng(6), ["bot"]);
    const cell1 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "human", instanceId: state.players[0].hand[0].instanceId, position: cell1 });
    const cell2 = getLegalPlacementCells(state)[0];
    state = applyAction(state, { type: "place", playerId: "bot", instanceId: state.players[1].hand[0].instanceId, position: cell2 }, () => 0.99);
    expect(state.votes.bot).toBe(false);
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
      aiDifficulty: "medium",
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
      handOffers: {},
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
    aiDifficulty: "medium",
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
    expect(state.currentPlayerIndex).toBe(2); // round 2 starts one seat further than round 1 did (see roundRotationShift)
  });
});

describe("advanceTurn — round-start seat rotation", () => {
  it("starts each round one seat further than the previous round, for 3+ players", () => {
    const config: GameConfig = {
      boardBounds: { width: 7, height: 7, center: { x: 3, y: 3 } },
      handSize: 4,
      roundCap: 10,
      flipUnlockRound: 2,
      centerEffect: "none",
      minRoundFloor: 10, // keep voting out of the way
      playerCount: 4,
      aiDifficulty: "medium",
    };
    let state = createGame(["p1", "p2", "p3", "p4"], config, deterministicRng(1), [], 0);
    expect(state.currentPlayerIndex).toBe(0); // round 1 starts at seat 0

    for (let i = 0; i < 4; i++) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    expect(state.round).toBe(2);
    expect(state.currentPlayerIndex).toBe(1); // round 2 starts one seat further

    for (let i = 0; i < 4; i++) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    expect(state.round).toBe(3);
    expect(state.currentPlayerIndex).toBe(2); // round 3 starts one seat further still

    // No seat ever acts twice in a row across either round boundary crossed above.
  });

  it("never shifts the round-start seat at 2p -- rotating there would always repeat the last actor immediately", () => {
    const config: GameConfig = {
      boardBounds: { width: 7, height: 7, center: { x: 3, y: 3 } },
      handSize: 4,
      roundCap: 10,
      flipUnlockRound: 2,
      centerEffect: "none",
      minRoundFloor: 10,
      playerCount: 2,
      aiDifficulty: "medium",
    };
    let state = createGame(["p1", "p2"], config, deterministicRng(1), [], 0);
    expect(state.currentPlayerIndex).toBe(0);

    for (let i = 0; i < 2; i++) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    expect(state.round).toBe(2);
    expect(state.currentPlayerIndex).toBe(0); // unchanged: round 2 still starts at seat 0, exactly as before this feature existed
  });

  it("shifts the round-start seat by 3 (not 1) at 8p, to reduce the residual turn-order exposure imbalance roundCap=6 leaves behind", () => {
    const playerIds = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const config: GameConfig = {
      boardBounds: { width: 9, height: 9, center: { x: 4, y: 4 } },
      handSize: 4,
      roundCap: 10,
      flipUnlockRound: 2,
      centerEffect: "none",
      minRoundFloor: 10, // keep voting out of the way
      playerCount: 8,
      aiDifficulty: "medium",
    };
    let state = createGame(playerIds, config, deterministicRng(1), [], 0);
    expect(state.currentPlayerIndex).toBe(0); // round 1 starts at seat 0

    for (let i = 0; i < 8; i++) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    expect(state.round).toBe(2);
    expect(state.currentPlayerIndex).toBe(3); // round 2 starts 3 seats further, not 1

    for (let i = 0; i < 8; i++) {
      const player = state.players[state.currentPlayerIndex];
      const cell = getLegalPlacementCells(state)[0];
      state = applyAction(state, { type: "place", playerId: player.id, instanceId: player.hand[0].instanceId, position: cell });
    }
    expect(state.round).toBe(3);
    expect(state.currentPlayerIndex).toBe(6); // round 3 starts 3 seats further still (0 -> 3 -> 6)
  });
});

describe("Hall of Fortunes center effect — per-turn 3-card offer, redrawn fresh from a shared pool", () => {
  const config: GameConfig = {
    boardBounds: { width: 9, height: 9, center: { x: 4, y: 4 } },
    handSize: 7, // unused for this location -- nobody's dealt a real starting hand (see createGame)
    roundCap: 10,
    flipUnlockRound: 2,
    centerEffect: "reckoning",
    minRoundFloor: 10, // keep voting out of the way for these tests
    playerCount: 2,
    aiDifficulty: "medium",
  };

  function placeOfferedCard(state: GameState): GameState {
    const player = state.players[state.currentPlayerIndex];
    const offered = offeredCardsFor(state, player.id)[0];
    const cell = getLegalPlacementCells(state)[0];
    return applyAction(state, { type: "place", playerId: player.id, instanceId: offered.instanceId, position: cell });
  }

  /** deck.length + every player's hand.length + however many cards are already on the board -- should never change: cards only ever move between these three buckets. */
  function totalCirculatingCards(state: GameState): number {
    return state.deck.length + state.players.reduce((sum, p) => sum + p.hand.length, 0) + state.board.size;
  }

  it("gives only the starting player an offer at deal time -- nobody else has a hand yet", () => {
    const state = createGame(["p1", "p2"], config, deterministicRng(6));
    const [p1, p2] = state.players;
    expect(state.handOffers[p1.id]).toHaveLength(3);
    expect(new Set(state.handOffers[p1.id].map((c) => c.cardId)).size).toBe(3); // unique by cardId
    expect(p1.hand).toEqual(state.handOffers[p1.id]);
    expect(p2.hand).toEqual([]);
    expect(state.handOffers[p2.id]).toBeUndefined();
  });

  it("rejects placing a hand card that isn't in the current offer", () => {
    const state = createGame(["p1", "p2"], config, deterministicRng(6));
    const player = state.players[0];
    const offer = state.handOffers[player.id];
    // Every card in `hand` IS the offer here (no larger fixed hand behind it), so
    // reaching for an "unoffered" card means a fabricated instanceId, not a real one.
    const cell = getLegalPlacementCells(state)[0];
    expect(() => applyAction(state, { type: "place", playerId: player.id, instanceId: "not-a-real-card", position: cell })).toThrow();
    expect(offer).toHaveLength(3);
  });

  it("consumes the offer once the offered card is placed, leaving the other 2 cards briefly in hand", () => {
    let state = createGame(["p1", "p2"], config, deterministicRng(6));
    const playerId = state.players[0].id;
    state = placeOfferedCard(state);
    expect(state.handOffers[playerId]).toBeUndefined();
    expect(state.players.find((p) => p.id === playerId)!.hand).toHaveLength(2);
  });

  it("shows no offered cards for a player between their own turns, even though 2 leftover cards are still technically in hand", () => {
    let state = createGame(["p1", "p2"], config, deterministicRng(6));
    const p1 = state.players[0].id;
    state = placeOfferedCard(state); // p1's offer is now consumed; it's p2's turn
    expect(offeredCardsFor(state, p1)).toEqual([]); // nothing should show as offered until p1's next turn
  });

  it("redraws a completely fresh 3-card offer once the player's turn comes back around", () => {
    let state = createGame(["p1", "p2"], config, deterministicRng(6));
    const p1 = state.players[0].id;
    const beforeCirculating = totalCirculatingCards(state);
    state = placeOfferedCard(state); // p1 places, consuming their offer
    state = placeOfferedCard(state); // p2 places -- round completes, back to p1
    expect(state.currentPlayerIndex).toBe(0); // 2p has no round-boundary rotation shift
    expect(state.handOffers[p1]).toHaveLength(3);
    expect(state.players.find((p) => p.id === p1)!.hand).toEqual(state.handOffers[p1]);
    // Nothing was created or destroyed -- deck+hands+board (totalCirculatingCards)
    // stays constant all game; only which bucket a given card sits in changes.
    expect(totalCirculatingCards(state)).toBe(beforeCirculating);
  });

  it("conserves the total card count across many turns -- cards only ever move between the deck, hands, and the board", () => {
    let state = createGame(["p1", "p2"], config, deterministicRng(6));
    const initial = totalCirculatingCards(state);
    for (let i = 0; i < 10; i++) {
      state = placeOfferedCard(state);
      expect(totalCirculatingCards(state)).toBe(initial);
      expect(state.board.size).toBe(i + 1);
    }
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

describe("configForPlayerCount — Free Cities' random ownerless tiles", () => {
  it("picks the same tiles for the same seed (reproducible)", () => {
    const a = configForPlayerCount(4, "freeCities", "medium", deterministicRng(7));
    const b = configForPlayerCount(4, "freeCities", "medium", deterministicRng(7));
    expect(a.boardBounds.ownerless).toEqual(b.boardBounds.ownerless);
  });

  it("picks different tiles for a different seed", () => {
    const a = configForPlayerCount(4, "freeCities", "medium", deterministicRng(7));
    const b = configForPlayerCount(4, "freeCities", "medium", deterministicRng(99));
    expect(a.boardBounds.ownerless).not.toEqual(b.boardBounds.ownerless);
  });

  it("scales ownerless tile count with board size", () => {
    const small = configForPlayerCount(2, "freeCities", "medium", deterministicRng(7));
    const large = configForPlayerCount(8, "freeCities", "medium", deterministicRng(7));
    expect(small.boardBounds.ownerless?.length).toBeGreaterThanOrEqual(1);
    expect(large.boardBounds.ownerless?.length ?? 0).toBeGreaterThan(small.boardBounds.ownerless?.length ?? 0);
  });

  it("every generated tile is unique and in bounds", () => {
    const config = configForPlayerCount(8, "freeCities", "medium", deterministicRng(3));
    const tiles = config.boardBounds.ownerless ?? [];
    const keys = new Set(tiles.map((p) => `${p.x},${p.y}`));
    expect(keys.size).toBe(tiles.length);
    for (const p of tiles) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(config.boardBounds.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(config.boardBounds.height);
    }
  });
});

describe("configForPlayerCount — Lazaret's coin-flipped diagonal", () => {
  it("uses the top-left/bottom-right diagonal on one outcome", () => {
    const config = configForPlayerCount(4, "championOfTheWeak", "medium", deterministicRng(1)); // rng() < 0.5
    expect(config.boardBounds.ownerless).toEqual([
      { x: 0, y: 0 },
      { x: config.boardBounds.width - 1, y: config.boardBounds.height - 1 },
    ]);
  });

  it("uses the top-right/bottom-left diagonal on the other outcome", () => {
    const config = configForPlayerCount(4, "championOfTheWeak", "medium", deterministicRng(8)); // rng() >= 0.5
    expect(config.boardBounds.ownerless).toEqual([
      { x: config.boardBounds.width - 1, y: 0 },
      { x: 0, y: config.boardBounds.height - 1 },
    ]);
  });

  it("is reproducible for the same seed", () => {
    const a = configForPlayerCount(4, "championOfTheWeak", "medium", deterministicRng(1));
    const b = configForPlayerCount(4, "championOfTheWeak", "medium", deterministicRng(1));
    expect(a.boardBounds.ownerless).toEqual(b.boardBounds.ownerless);
  });
});
