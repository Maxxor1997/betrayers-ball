import { describe, expect, it } from "vitest";
import { CARD_DEFS, copiesForPlayerCount } from "../../content/cards";
import { chooseGreedyAiAction, placementHeuristicAdjustment } from "../greedyAi";
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
      aiDifficulty: "medium",
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
  aiDifficulty: "medium",
};

let counter = 0;
function card(cardId: CardId, ownerId: string, faceUp = false): CardInstance {
  return { instanceId: `c${counter++}`, cardId, ownerId, faceUp };
}

/**
 * The exploration-rate tests below need to know the *real* current base rate,
 * including greedyAi.ts's DOOMHERALD_DECK_PRESENCE_EXPLORATION_DISCOUNT -- which only
 * applies while Chronicler/Doomherald actually has copies in the deck at this CONFIG's
 * player count. Computed from the same public API the production code uses
 * (copiesForPlayerCount) rather than hardcoded, since that card is under active
 * tuning and gets toggled disabled/enabled in cards.ts independently of this file.
 */
const BASE_EXPLORATION = copiesForPlayerCount(CARD_DEFS.Chronicler, CONFIG.playerCount) > 0 ? 0.65 : 0.75;

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
    flipHistory: [],
    placementOrder: [],
    handOffers: {},
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

  it("does NOT exploit the same Bannerman's TRUE identity while it's still face-down (hidden info stays hidden)", () => {
    // Note: a legal, honest reason to prefer a cell next to *any* hidden card can
    // exist -- expectedHiddenNeighborAdjustments (see endgame.ts) weighs every still-
    // hidden position by public deck-composition odds across every possible identity,
    // which is fair game since it never depends on which identity this hidden card
    // actually is. What must stay impossible is the placement decision changing based
    // on the hidden card's *true* identity -- that would mean its cardId (redacted to
    // "Unknown" for p1) leaked through. So: build the same board with the hidden card
    // actually being a Bannerman, and again with it actually being some other
    // high-impact card, and confirm p1's choice is identical either way.
    function stateWithHiddenCard(hiddenCardId: CardId): GameState {
      const board: Board = new Map();
      board.set(posKey({ x: 3, y: 2 }), card(hiddenCardId, "p2", false)); // face-down -- unknown to p1
      const handCard = card("Footman", "p1");
      return makeState({
        board,
        players: [
          { id: "p1", hand: [handCard], isAI: true },
          { id: "p2", hand: [], isAI: true },
        ],
      });
    }

    for (let seed = 0; seed < 10; seed++) {
      const bannermanAction = chooseGreedyAiAction(stateWithHiddenCard("Bannerman"), "p1", deterministicRng(100 + seed));
      const truthseekerAction = chooseGreedyAiAction(stateWithHiddenCard("Truthseeker"), "p1", deterministicRng(100 + seed));
      // Compare shape only, not instanceId -- each stateWithHiddenCard call mints its
      // own fresh handCard instance (via the shared `counter` in card()), so the two
      // actions' instanceIds necessarily differ even when the decision itself matches.
      expect(bannermanAction.type).toBe(truthseekerAction.type);
      if (bannermanAction.type === "place" && truthseekerAction.type === "place") {
        expect(bannermanAction.position).toEqual(truthseekerAction.position);
      }
    }
  });
});

describe("chooseGreedyAiAction — flip actually looks ahead", () => {
  it("never self-flips its own face-down Gloryseeker, even though the +3 would help -- opponentOnlyFlip forbids it", () => {
    // Gloryseeker is the only card whose own value improves from being face-up, so
    // this used to be the example proving chooseFlip's own-card, value-ranked branch
    // works. Now that Gloryseeker is opponentOnlyFlip (see lib/content/cards.ts),
    // getLegalFlipTargets excludes it from its own owner's options entirely -- the AI
    // has nothing else to flip and an empty hand, so it passes instead.
    const board: Board = new Map();
    const gloryseeker = card("Gloryseeker", "p1", false);
    board.set(posKey({ x: 3, y: 2 }), gloryseeker);
    const state = makeState({ board, round: 3 });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(2));
    expect(action).toEqual({ type: "pass", playerId: "p1" });
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

describe("chooseGreedyAiAction — Truthseeker/Beacon-aware flip targeting", () => {
  it("avoids flipping an opponent card a known (own) Truthseeker is already quietly damaging", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p1")); // anchor -- equidistant from both targets
    board.set(posKey({ x: 1, y: 1 }), card("Truthseeker", "p1")); // known (own); adjacent only to target A
    const targetA = card("Footman", "p2", false);
    const targetB = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 1 }), targetA); // adjacent to the Truthseeker -- already being damaged
    board.set(posKey({ x: 2, y: 3 }), targetB); // no special neighbor
    const state = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", () => 0.01);
    expect(action).toEqual({ type: "flip", playerId: "p1", instanceId: targetB.instanceId });
  });

  it("prefers flipping an opponent card adjacent to the AI's own face-up Beacon (Nightjar) -- flipping the target creates a matching-face-state neighbor", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p1")); // anchor -- equidistant from both targets
    board.set(posKey({ x: 1, y: 1 }), card("Beacon", "p1", true)); // known (own), face-up; adjacent only to target A
    const targetA = card("Footman", "p2", false);
    const targetB = card("Footman", "p2", false);
    // Flipping targetA face-up creates a face-up/face-up match with the AI's own
    // face-up Beacon -- a real +1 for the AI (see cards.ts's "matches own face state").
    board.set(posKey({ x: 2, y: 1 }), targetA);
    board.set(posKey({ x: 2, y: 3 }), targetB); // no special neighbor
    const state = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", () => 0.01);
    expect(action).toEqual({ type: "flip", playerId: "p1", instanceId: targetA.instanceId });
  });

  it("avoids flipping an opponent card adjacent to the AI's own face-down Beacon -- flipping the target would break an existing match", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p1")); // anchor -- equidistant from both targets
    board.set(posKey({ x: 1, y: 1 }), card("Beacon", "p1", false)); // known (own), face-down; adjacent only to target A
    const targetA = card("Footman", "p2", false);
    const targetB = card("Footman", "p2", false);
    // targetA is currently face-down, matching the AI's own face-down Beacon -- flipping
    // it breaks that match, a real -1 for the AI, so it should be avoided in favor of B.
    board.set(posKey({ x: 2, y: 1 }), targetA);
    board.set(posKey({ x: 2, y: 3 }), targetB); // no special neighbor
    const state = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", () => 0.01);
    expect(action).toEqual({ type: "flip", playerId: "p1", instanceId: targetB.instanceId });
  });

  it("avoids flipping an opponent card adjacent to an opponent's revealed face-up Beacon -- flipping it would help them", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p1")); // anchor -- equidistant from both targets
    board.set(posKey({ x: 1, y: 1 }), card("Beacon", "p2", true)); // revealed, so known; adjacent only to target A
    const targetA = card("Footman", "p2", false);
    const targetB = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 1 }), targetA); // adjacent to a rival's face-up Beacon -- flipping it helps them, not the AI
    board.set(posKey({ x: 2, y: 3 }), targetB); // no special neighbor
    const state = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", () => 0.01);
    expect(action).toEqual({ type: "flip", playerId: "p1", instanceId: targetB.instanceId });
  });

  it("prefers flipping an opponent card adjacent to the AI's own high-base face-up card -- a live Infiltrator-swap threat", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p1", true)); // anchor -- equidistant from both targets
    board.set(posKey({ x: 1, y: 1 }), card("Warlord", "p1", true)); // own, face-up, high base -- worth protecting
    const targetA = card("Footman", "p2", false);
    const targetB = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 1 }), targetA); // adjacent to the AI's own Warlord -- could be an Infiltrator staged to steal it
    board.set(posKey({ x: 2, y: 3 }), targetB); // no special neighbor
    const state = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", () => 0.01);
    expect(action).toEqual({ type: "flip", playerId: "p1", instanceId: targetA.instanceId });
  });

  it("explores less often when holding a Truthseeker -- preserves face-down opponent targets for later", () => {
    const board: Board = new Map();
    const opponentCard = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 2 }), opponentCard);
    const truthseeker = card("Truthseeker", "p1");
    const withTruthseeker = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [truthseeker], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });
    const withoutTruthseeker = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    // Midpoint between BASE_EXPLORATION and the further Truthseeker-in-hand-discounted
    // rate (-0.15) -- clears the baseline but not the discounted one.
    const midpoint = () => BASE_EXPLORATION - 0.075;
    const baseline = chooseGreedyAiAction(withoutTruthseeker, "p1", midpoint);
    const discounted = chooseGreedyAiAction(withTruthseeker, "p1", midpoint);
    expect(baseline.type).toBe("flip");
    expect(discounted.type).not.toBe("flip");
  });

  it("holding a Beacon (Nightjar) no longer nudges the exploration rate at all -- removed once it stopped unconditionally wanting more face-up neighbors", () => {
    // Nightjar keys off matching its own face-up/down state, not "more face-up cards is
    // always good" (see cards.ts) -- whether more face-up cards helps depends on what
    // face state it and its owner's own future flips end up in, which isn't knowable
    // from hand alone, so there's no honest directional lean anymore (see
    // HAND_TRUTHSEEKER_EXPLORATION_DISCOUNT's doc comment in greedyAi.ts). Holding one
    // should produce the exact same explore/don't-explore decision as not holding one,
    // at a rate that would have cleared the old (now-removed) boosted threshold.
    const board: Board = new Map();
    const opponentCard = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 2 }), opponentCard);
    const beacon = card("Beacon", "p1");
    const withBeacon = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [beacon], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });
    const withoutBeacon = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    // Comfortably below BASE_EXPLORATION -- clears the (single, unboosted) threshold
    // either way, so both scenarios explore and should land on the exact same target.
    const rng = () => BASE_EXPLORATION - 0.075;
    const baseline = chooseGreedyAiAction(withoutBeacon, "p1", rng);
    const withHand = chooseGreedyAiAction(withBeacon, "p1", rng);
    expect(baseline.type).toBe("flip");
    expect(withHand.type).toBe("flip");
    expect(baseline).toEqual(withHand);
  });

  it("explores less often when holding an Infiltrator -- protects a card that needs to stay hidden", () => {
    const board: Board = new Map();
    const opponentCard = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 2 }), opponentCard);
    const infiltrator = card("Infiltrator", "p1");
    const withInfiltrator = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [infiltrator], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });
    const withoutInfiltrator = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    // Midpoint between BASE_EXPLORATION and the further Infiltrator-in-hand-discounted
    // rate (-0.15) -- clears the baseline but not the discounted one.
    const midpoint = () => BASE_EXPLORATION - 0.075;
    const baseline = chooseGreedyAiAction(withoutInfiltrator, "p1", midpoint);
    const discounted = chooseGreedyAiAction(withInfiltrator, "p1", midpoint);
    expect(baseline.type).toBe("flip");
    expect(discounted.type).not.toBe("flip");
  });

  it("explores less often with a face-down Infiltrator already on the board too, not just in hand", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p2", false));
    board.set(posKey({ x: 5, y: 5 }), card("Infiltrator", "p1", false));
    const state = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", () => 0.65);
    expect(action.type).not.toBe("flip");
  });

  it("does not discount exploration for an already-face-up Infiltrator -- nothing left to protect", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p2", false));
    board.set(posKey({ x: 5, y: 5 }), card("Infiltrator", "p1", true));
    const state = makeState({
      board,
      round: 2,
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    // No Infiltrator discount (already face-up) -- just BASE_EXPLORATION itself.
    const action = chooseGreedyAiAction(state, "p1", () => BASE_EXPLORATION - 0.05);
    expect(action.type).toBe("flip");
  });
});

/**
 * A one-ply greedy evaluation only ever sees the board "as if scoring the instant
 * after this placement" -- it has no way to know how the game unfolds on later turns.
 * These cover the round/hand/board-aware nudges (see greedyAi.ts's
 * placementHeuristicAdjustment) that correct for that blind spot on specific cards.
 * Each test sets up a hand with two cards whose *naive* (unadjusted) margins favor the
 * "wrong" one, and confirms the adjustment flips which one the AI actually picks --
 * not just that the targeted card's own score moved somewhere internally.
 */
describe("chooseGreedyAiAction — placement heuristics correct for what a one-ply evaluation can't see", () => {
  it("credits a face-down Doomherald (Chronicler) with expected damage to its current neighbors, weighted by the chance an opponent flips it", () => {
    // Doomherald deals -3 to every adjacent card once face-up, but opponentOnlyFlip
    // means only an opponent can ever trigger it -- placed face-down (the common
    // case), the raw margin sees none of that yet. Two already-placed enemy
    // neighbors should out-credit a flat Bannerman (base 4, no neighbors of its own
    // to buff -- buffing these same enemy Footmen would only help the opponent, so
    // its own best placement is an isolated cell, e.g. next to the empty center)
    // even though Doomherald's own base (3) is lower and it currently does nothing
    // on its own.
    const board: Board = new Map();
    board.set(posKey({ x: 1, y: 0 }), card("Footman", "p2", true));
    board.set(posKey({ x: 0, y: 1 }), card("Footman", "p2", true));
    const doomherald = card("Chronicler", "p1");
    const bannerman = card("Bannerman", "p1");
    const state = makeState({
      board,
      round: 1,
      players: [
        { id: "p1", hand: [doomherald, bannerman], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") {
      expect(action.instanceId).toBe(doomherald.instanceId);
      expect(action.position).toEqual({ x: 0, y: 0 });
    }
  });

  it("values Dying God at the expected end-of-game round instead of the current (early) round", () => {
    // Naive (round-1) values: Dying God = base(10)-1=9. Pretender's only possible
    // neighbor on an empty board is the ownerless center, which getAdjacentCards
    // excludes (it's not a real CardInstance), so its own -4 never fires and it's
    // effectively a flat base = 7 -- Dying God wins on its inflated early snapshot.
    // The expected-final-round correction docks Dying God down instead:
    // 10 - expectedFinalRound(4.5) = 5.5, which now loses to Pretender.
    const dyingGod = card("DyingGod", "p1");
    const pretender = card("Pretender", "p1");
    const state = makeState({
      round: 1,
      players: [
        { id: "p1", hand: [dyingGod, pretender], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") expect(action.instanceId).toBe(pretender.instanceId);
  });

  it("discounts Exile's early placements for the extra neighbors it'll likely gain before scoring", () => {
    // On an empty board, every legal (center-adjacent) cell already counts the center
    // itself as one occupied neighbor, so naive Exile = base - 1 = 8; Pretender's only
    // possible neighbor there is the ownerless center, which getAdjacentCards excludes
    // (it's not a real CardInstance), so Pretender's own -4 never fires and it's
    // effectively a flat base = 7. Naively Exile still wins (8 > 7) -- the
    // future-neighbor discount, placed this early with 3 remaining rounds, should flip it.
    const exile = card("Exile", "p1");
    const pretender = card("Pretender", "p1");
    const state = makeState({
      round: 1,
      players: [
        { id: "p1", hand: [exile, pretender], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") expect(action.instanceId).toBe(pretender.instanceId);
  });

  it("values Commander more highly when the player still has a Footman in hand to set up next to it", () => {
    // Naively (no Footman adjacent yet) Bannerman's flat base beats Commander's bare
    // base -- the hand-Footman credit plus the early-game setup bonus should flip it.
    const commander = card("Commander", "p1");
    const bannerman = card("Bannerman", "p1");
    const footman = card("Footman", "p1"); // stays in hand either way -- not itself a candidate here
    const state = makeState({
      round: 1,
      players: [
        { id: "p1", hand: [commander, bannerman, footman], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") expect(action.instanceId).toBe(commander.instanceId);
  });

  it("values a face-down Gloryseeker more highly the earlier it's placed, for the chance it gets flipped before scoring", () => {
    // Naively (face-down, no +3 yet) a flat Bannerman (same base 4, no neighbors here
    // to trigger its own effect either) ties it -- the earlier-round flip chance should
    // flip which one wins, in Gloryseeker's favor. A flat Footman (base 5) is too big a
    // gap for the flip-chance heuristic to close now that Gloryseeker is
    // opponentOnlyFlip (see lib/content/cards.ts) -- its own owner can no longer
    // self-flip it, so this only credits the chance an opponent bothers to.
    const gloryseeker = card("Gloryseeker", "p1");
    const bannerman = card("Bannerman", "p1");
    const state = makeState({
      round: 1,
      players: [
        { id: "p1", hand: [gloryseeker, bannerman], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") expect(action.instanceId).toBe(gloryseeker.instanceId);
  });

  it("discounts a face-down Infiltrator's current swap value for the risk of getting flipped, with few face-down peers on the board", () => {
    // A same-owner Giant is already down for Infiltrator to swap with (its true base
    // is visible to its own owner, no hidden-info issue) -- naively that swap makes
    // Infiltrator worth more than a flat Footman. Placed this early, with hardly any
    // face-down cards on the board yet, the flip-risk/exposure discount should flip it.
    const giant = card("Giant", "p1", true);
    const board: Board = new Map();
    board.set(posKey({ x: 3, y: 2 }), giant);
    const infiltrator = card("Infiltrator", "p1");
    const footman = card("Footman", "p1");
    const state = makeState({
      board,
      round: 1,
      players: [
        { id: "p1", hand: [infiltrator, footman], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") expect(action.instanceId).toBe(footman.instanceId);
  });

  it("prefers the row that hits the most enemy cards for Earthshaker, not just whichever helps against the current leader", () => {
    const board: Board = new Map();
    // p2 is a guaranteed, untouchable leader -- its single Giant sits at (5,5) with its
    // entire row (y=5) AND entire column (x=5) fully packed edge-to-edge, so there is
    // no empty cell anywhere in that row or column. Earthshaker's -2 only ever reaches
    // along its OWN row/column (an unbroken run from wherever it's placed), and it can
    // only ever be placed on an empty cell -- so it can never even be placed inside row
    // 5 or column 5, let alone reach the Giant sitting at their intersection. That
    // isolates the comparison below: since p2's total never moves either way, the
    // *real* margin ties between hitting p3's row 2 (1 contiguous card) and row 4 (2
    // contiguous cards) -- only the disruption heuristic should tell them apart.
    for (let x = 0; x < 7; x++) {
      if (x !== 5) board.set(posKey({ x, y: 5 }), card("Footman", "p2"));
    }
    for (let y = 0; y < 7; y++) {
      if (y !== 5) board.set(posKey({ x: 5, y }), card("Footman", "p2"));
    }
    board.set(posKey({ x: 5, y: 5 }), card("Giant", "p2", true));

    board.set(posKey({ x: 0, y: 2 }), card("Footman", "p3"));
    // Contiguous pair in row 4 -- a single Earthshaker placement can chain through both.
    board.set(posKey({ x: 0, y: 4 }), card("Footman", "p3"));
    board.set(posKey({ x: 1, y: 4 }), card("Footman", "p3"));

    const earthshaker = card("Earthshaker", "p1");
    const state = makeState({
      board,
      round: 1,
      players: [
        { id: "p1", hand: [earthshaker], isAI: true },
        { id: "p2", hand: [], isAI: true },
        { id: "p3", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") expect(action.position.y).toBe(4);
  });

  it("values Zeus-Born at the expected end-of-game round instead of the current (early) round", () => {
    // Naive (round-1) values: Zeus-Born = base(2)+1=3. A lone Footman (no line of
    // 3+ to complete) is a flat base = 5 -- Footman wins on Zeus-Born's deflated
    // early snapshot. The expected-final-round correction credits Zeus-Born up
    // instead: 2 + expectedFinalRound(4.5) = 6.5, which now beats Footman.
    const skysplitter = card("Skysplitter", "p1");
    const footman = card("Footman", "p1");
    const state = makeState({
      round: 1,
      players: [
        { id: "p1", hand: [skysplitter, footman], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action.type).toBe("place");
    if (action.type === "place") expect(action.instanceId).toBe(skysplitter.instanceId);
  });

  it("prefers hurting a non-leader opponent over an equally-scoring placement that hurts no one, for any card -- not just Earthshaker", () => {
    // This is the generic nonLeaderDisruptionBonus mechanism, not a per-card special
    // case -- proven here with Suppressor, which isn't in placementHeuristicAdjustment's
    // switch at all. Suppressor has no self-scoring effect of its own, so the *real*
    // margin comes out identical for both candidate cells below; only the generic
    // disruption credit tells them apart.
    const board: Board = new Map();
    // p2 is a guaranteed, untouchable leader, far outscoring anything p3 can lose.
    board.set(posKey({ x: 6, y: 6 }), card("Giant", "p2", true));
    board.set(posKey({ x: 6, y: 5 }), card("Giant", "p2", true));

    // p3's face-up Gloryseeker, currently earning its own +3 self-effect.
    board.set(posKey({ x: 3, y: 1 }), card("Gloryseeker", "p3", true));

    // Padding so both candidate Suppressor cells reach the 3-occupied-neighbor
    // threshold (center at (3,3) already counts as one for each). Giants, not
    // Footmen -- a Footman's own effect counts *any* owned card sharing its row/column,
    // so Suppressor's own placement would accidentally complete row/column synergies
    // for Footman padding (and negation would sometimes cancel them again), swamping
    // the one signal this test means to isolate. Giants have no effect at all.
    board.set(posKey({ x: 2, y: 2 }), card("Giant", "p1", true));
    board.set(posKey({ x: 4, y: 2 }), card("Giant", "p1", true));
    board.set(posKey({ x: 2, y: 4 }), card("Giant", "p1", true));

    const suppressor = card("Suppressor", "p1");
    const state = makeState({
      board,
      round: 1,
      players: [
        { id: "p1", hand: [suppressor], isAI: true },
        { id: "p2", hand: [], isAI: true },
        { id: "p3", hand: [], isAI: true },
      ],
    });

    // (3,2) is adjacent to p3's Gloryseeker -- negating it strips the +3, hurting p3
    // (not the leader, so the real margin doesn't see it at all). Every other legal
    // cell also clears the 3-neighbor threshold but touches nothing with an active
    // effect to lose -- a real tie on paper (all candidates score margin 9).
    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action).toEqual({ type: "place", playerId: "p1", instanceId: suppressor.instanceId, position: { x: 3, y: 2 } });
  });
});

describe("placementHeuristicAdjustment — Berserker EV credit (derived from public info, not a flat guess)", () => {
  // Berserker is worthless by pure margin math until an opponent plays a matching one
  // -- this credit is what keeps it from being pruned out of twoPly.ts's top-K
  // candidates almost every game (measured at ~1% Hard playrate before any credit
  // existed here). Berserker only has copies in the deck at 5+ players (count:
  // [0,0,0,7,7,7,7], indexed from MIN_PLAYERS=2 -- see copiesForPlayerCount), so
  // these tests need a 5p config, not the file's shared 2p CONFIG.
  const CONFIG_5P: GameConfig = { ...CONFIG, playerCount: 5, minRoundFloor: 2, roundCap: 6 };

  it("credits 2x the expected number of NEW rival owners, derived from opponent hand sizes and rounds remaining", () => {
    const position = { x: 3, y: 3 };
    const berserker = card("Berserker", "p1");
    const board: Board = new Map([[posKey(position), berserker]]); // just this placement -- no other Berserkers on the board yet
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [card("Footman", "p2")], isAI: true }, // the only opponent with any cards left at all
      { id: "p3", hand: [], isAI: true },
      { id: "p4", hand: [], isAI: true },
      { id: "p5", hand: [], isAI: true },
    ];
    const preState = makeState({ config: CONFIG_5P, round: 1, players });
    const postState = makeState({ config: CONFIG_5P, round: 1, players, board });

    // 7 total Berserker copies at 5p (see count: [0,0,0,7,7,7,7]), 1 already placed
    // (this one) -> 6 hidden copies, all necessarily somewhere in p2's hand-pool since
    // p2 is the only opponent holding any cards -- so the per-draw rate saturates at 1
    // (capped, since 6 hidden > p2's 1-card pool). expectedFinalRound = (2+6)/2 = 4,
    // round 1 -> 3 rounds remaining, but p2 only has 1 card left, so k = min(3,1) = 1:
    // p2 is certain to play their one remaining card, and it's certain (rate=1) to be
    // a Berserker -- exactly 1 expected new rival owner, worth +2.
    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: berserker.instanceId, position }, postState);
    expect(adjustment).toBe(2);
  });

  it("credits nothing once the only opponent with cards left already has a known (face-up) Berserker", () => {
    const position = { x: 3, y: 3 };
    const berserker = card("Berserker", "p1");
    const board: Board = new Map([
      [posKey(position), berserker],
      [posKey({ x: 0, y: 0 }), card("Berserker", "p2", true)], // already face-up -- a known, already-counted rival owner
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [card("Footman", "p2")], isAI: true },
      { id: "p3", hand: [], isAI: true },
      { id: "p4", hand: [], isAI: true },
      { id: "p5", hand: [], isAI: true },
    ];
    const preState = makeState({ config: CONFIG_5P, round: 1, players });
    const postState = makeState({ config: CONFIG_5P, round: 1, players, board });

    // p2 (the only opponent with cards left) is excluded from the estimate since
    // they're already a known owner -- p3/p4 have no cards left, so nothing remains
    // to speculate about.
    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: berserker.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });
});

describe("placementHeuristicAdjustment — Warlord risk discount (mirror image of Berserker's credit)", () => {
  // Warlord (base 8, -3 per unique enemy owner) has copies even at 2p (count:
  // [6,6,5,4,4,4,4]), unlike Berserker -- the file's shared 2p CONFIG works fine here.
  it("docks 3x the expected number of NEW rival owners, as a risk discount rather than a credit", () => {
    const position = { x: 3, y: 3 };
    const warlord = card("Warlord", "p1");
    const board: Board = new Map([[posKey(position), warlord]]); // just this placement -- no other Warlords on the board yet
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [card("Footman", "p2")], isAI: true }, // the only opponent, with 1 card left
    ];
    const preState = makeState({ round: 1, players });
    const postState = makeState({ round: 1, players, board });

    // 6 total Warlord copies at 2p, 1 already placed (this one) -> 5 hidden, all
    // necessarily in p2's 1-card hand -- per-draw rate saturates at 1 (capped).
    // expectedFinalRound = (3+6)/2 = 4.5, round 1 -> 3.5 rounds remaining, but p2 only
    // has 1 card left, so k = min(3.5,1) = 1: p2 is certain to play their one
    // remaining card, and it's certain to be a Warlord -- exactly 1 expected new
    // rival owner, docked as -3 (not credited as +3, since this is a penalty card).
    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: warlord.instanceId, position }, postState);
    expect(adjustment).toBe(-3);
  });

  it("docks nothing once the only opponent already has a known (face-up) Warlord", () => {
    const position = { x: 3, y: 3 };
    const warlord = card("Warlord", "p1");
    const board: Board = new Map([
      [posKey(position), warlord],
      [posKey({ x: 0, y: 0 }), card("Warlord", "p2", true)], // already face-up -- a known, already-counted rival owner
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [card("Footman", "p2")], isAI: true },
    ];
    const preState = makeState({ round: 1, players });
    const postState = makeState({ round: 1, players, board });

    // p2 is the only opponent, and they're already a known owner -- no opponents left
    // to speculate about.
    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: warlord.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });
});

describe("placementHeuristicAdjustment — Gloryseeker's flip-chance credit uses the exact remaining opponent-turn count", () => {
  it("credits exactly 0 when placed on the deterministic last opponent turn of the game -- no one is left to ever flip it", () => {
    const position = { x: 3, y: 3 };
    const gloryseeker = card("Gloryseeker", "p1", false);
    const board: Board = new Map([[posKey(position), gloryseeker]]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    // Same "p1 is the very last player to act at roundCap" setup as the Facestealer
    // tests below.
    const preState = makeState({ round: 6, turnsThisRound: 1, players });
    const postState = makeState({ round: 6, turnsThisRound: 1, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: gloryseeker.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });

  it("credits a real (nonzero) chance one opponent turn before that same deterministic end", () => {
    const position = { x: 3, y: 3 };
    const gloryseeker = card("Gloryseeker", "p1", false);
    const board: Board = new Map([[posKey(position), gloryseeker]]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 6, turnsThisRound: 0, players });
    const postState = makeState({ round: 6, turnsThisRound: 0, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: gloryseeker.instanceId, position }, postState);
    expect(adjustment).toBeGreaterThan(0);
  });
});

describe("placementHeuristicAdjustment — Earthshaker's flip-chance credit (own-flip AND opponent-flip channels)", () => {
  it("credits 0 when there's nothing adjacent for it to hit even if flipped -- no benefit to weight a chance on", () => {
    const position = { x: 3, y: 3 };
    const earthshaker = card("Earthshaker", "p1", false);
    const board: Board = new Map([[posKey(position), earthshaker]]); // isolated, nothing in its row/column
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 3, turnsThisRound: 0, players });
    const postState = makeState({ round: 3, turnsThisRound: 0, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: earthshaker.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });

  it("credits 0 when already face-up -- its real effect already counts in the fair margin, nothing left to guess at", () => {
    const position = { x: 3, y: 3 };
    const earthshaker = card("Earthshaker", "p1", true); // forced face-up for this test, not a real placement rule
    const board: Board = new Map([
      [posKey(position), earthshaker],
      [posKey({ x: 4, y: 3 }), card("Footman", "p2", true)],
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 3, turnsThisRound: 0, players });
    const postState = makeState({ round: 3, turnsThisRound: 0, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: earthshaker.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });

  it("credits a real (nonzero) chance when flipping would genuinely help, combining both the owner's own deliberate flip and an opponent's blind one", () => {
    const position = { x: 3, y: 3 };
    const earthshaker = card("Earthshaker", "p1", false);
    // Two opponent-owned neighbors in the same row -- flipping would land -2 on each,
    // a clear net gain for p1's own margin.
    const board: Board = new Map([
      [posKey(position), earthshaker],
      [posKey({ x: 2, y: 3 }), card("Footman", "p2", true)],
      [posKey({ x: 4, y: 3 }), card("Footman", "p2", true)],
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 3, turnsThisRound: 0, players });
    const postState = makeState({ round: 3, turnsThisRound: 0, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: earthshaker.instanceId, position }, postState);
    expect(adjustment).toBeGreaterThan(0);
  });

  it("credits exactly 0 when placed on the deterministic last turn of the game -- neither the owner nor any opponent has a future turn left to ever flip it", () => {
    const position = { x: 3, y: 3 };
    const earthshaker = card("Earthshaker", "p1", false);
    const board: Board = new Map([
      [posKey(position), earthshaker],
      [posKey({ x: 4, y: 3 }), card("Footman", "p2", true)], // would clearly benefit from a flip, if only there were time left
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    // Same "last player to act at roundCap" setup as the Gloryseeker test above --
    // exactRemainingOpponentTurns AND exactRemainingOwnTurns both hit 0 here, since
    // both share the same "future rounds" range and roundCap leaves none.
    const preState = makeState({ round: 6, turnsThisRound: 1, players });
    const postState = makeState({ round: 6, turnsThisRound: 1, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: earthshaker.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });
});

describe("placementHeuristicAdjustment — Facestealer's swap-risk discount", () => {
  // Padding face-down cards so INFILTRATOR_FEW_FACE_DOWN_PENALTY never fires in these
  // tests -- they're specifically about the swap-value-at-stake term, not the separate
  // few-face-down-peers penalty.
  function padding(): [string, CardInstance][] {
    return [
      [posKey({ x: 6, y: 6 }), card("Footman", "p2", false)],
      [posKey({ x: 6, y: 5 }), card("Footman", "p2", false)],
      [posKey({ x: 5, y: 6 }), card("Footman", "p2", false)],
    ];
  }

  it("is a real risk (negative) when the swap it's currently holding is good for this player", () => {
    const position = { x: 3, y: 3 };
    const infiltrator = card("Infiltrator", "p1", false);
    const board: Board = new Map([
      [posKey(position), infiltrator],
      [posKey({ x: 3, y: 2 }), card("Warlord", "p2", true)], // base 8, no rival Warlords -- a clean, valuable swap target
      ...padding(),
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 1, players });
    const postState = makeState({ round: 1, players, board });

    // Swapping into Warlord (8) beats staying Infiltrator (3) if flipped -- real value
    // at stake, so getting flipped before scoring is a genuine downside.
    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: infiltrator.instanceId, position }, postState);
    expect(adjustment).toBeLessThan(0);
  });

  it("flips sign into a real relief (positive) when the swap it's currently holding is bad for this player", () => {
    const position = { x: 3, y: 3 };
    const infiltrator = card("Infiltrator", "p1", false);
    const board: Board = new Map([
      [posKey(position), infiltrator],
      // Suppressor: base 2, below Infiltrator's own base of 3, and has no
      // valueModifier of its own -- a clean flat-base comparison (Berserker would work
      // numerically too, but its own rule scans the *real* board for enemy Berserkers,
      // and since Facestealer never actually rewrites cardId anymore, the real
      // Suppressor/Berserker card is still genuinely sitting there for that scan to
      // find, muddying a test that's specifically about the base comparison).
      [posKey({ x: 3, y: 2 }), card("Suppressor", "p2", true)],
      ...padding(),
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 1, players });
    const postState = makeState({ round: 1, players, board });

    // Swapping into Suppressor (2) is worse than staying Infiltrator (3) if flipped --
    // this swap is currently hurting this player, so a flip would be a relief, not a
    // risk: the term should credit, not dock.
    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: infiltrator.instanceId, position }, postState);
    expect(adjustment).toBeGreaterThan(0);
  });

  it("is exactly 0 (net of the few-face-down penalty) when there's no neighbor to swap with", () => {
    const position = { x: 3, y: 3 };
    const infiltrator = card("Infiltrator", "p1", false);
    const board: Board = new Map([[posKey(position), infiltrator], ...padding()]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 1, players });
    const postState = makeState({ round: 1, players, board });

    // No eligible face-up neighbor -> no swap at all -> flipping it changes nothing,
    // so there's genuinely nothing at stake either way.
    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: infiltrator.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });

  it("reads as exactly 0 risk (net of the few-face-down penalty) when placed on the deterministic last opponent turn of the game -- nobody is left to flip it", () => {
    const position = { x: 3, y: 3 };
    const infiltrator = card("Infiltrator", "p1", false);
    const board: Board = new Map([
      [posKey(position), infiltrator],
      [posKey({ x: 3, y: 2 }), card("Warlord", "p2", true)], // a genuinely valuable swap target
      ...padding(),
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    // CONFIG.roundCap is 6 and CONFIG.playerCount is 2 -- round 6 with 1 opponent
    // turn already completed this round (turnsThisRound: 1) means p1 is the very
    // last player to act before the game is guaranteed to end (shouldEndGame forces
    // it at roundCap regardless of any vote -- see game.ts's advanceTurn). No
    // opponent turn remains after this placement at all.
    const preState = makeState({ round: 6, turnsThisRound: 1, players });
    const postState = makeState({ round: 6, turnsThisRound: 1, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: infiltrator.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });

  it("still reads as a real (nonzero) risk one opponent turn before that same deterministic end", () => {
    const position = { x: 3, y: 3 };
    const infiltrator = card("Infiltrator", "p1", false);
    const board: Board = new Map([
      [posKey(position), infiltrator],
      [posKey({ x: 3, y: 2 }), card("Warlord", "p2", true)],
      ...padding(),
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    // Same final round, but p1 is first to act (turnsThisRound: 0) -- p2 still gets
    // one more turn (and one more chance to flip) after this placement, before the
    // game ends.
    const preState = makeState({ round: 6, turnsThisRound: 0, players });
    const postState = makeState({ round: 6, turnsThisRound: 0, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: infiltrator.instanceId, position }, postState);
    expect(adjustment).toBeLessThan(0);
  });
});

describe("placementHeuristicAdjustment — Cyclops's Facestealer-protection credit", () => {
  it("credits back exactly what the adjacent Facestealer's own swap-risk term currently discounts", () => {
    const infPos = { x: 3, y: 2 };
    const cyclopsPos = { x: 3, y: 3 };
    const infiltrator = card("Infiltrator", "p1", false);
    const cyclops = card("Giant", "p1", true);
    // Same padding as above, plus a valuable swap target so there's real value at
    // stake for the Cyclops to protect.
    const boardWithoutCyclops: Board = new Map([
      [posKey(infPos), infiltrator],
      [posKey({ x: 2, y: 2 }), card("Warlord", "p2", true)],
      [posKey({ x: 6, y: 6 }), card("Footman", "p2", false)],
      [posKey({ x: 6, y: 5 }), card("Footman", "p2", false)],
      [posKey({ x: 5, y: 6 }), card("Footman", "p2", false)],
    ]);
    const boardWithCyclops: Board = new Map([...boardWithoutCyclops, [posKey(cyclopsPos), cyclops]]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 1, players, board: boardWithoutCyclops });
    const postState = makeState({ round: 1, players, board: boardWithCyclops });

    // The Facestealer's own standalone risk term (same board, no Cyclops yet) --
    // what the Cyclops placement should exactly cancel out for that one neighbor.
    const infiltratorOwnRisk = placementHeuristicAdjustment(
      makeState({ round: 1, players, board: boardWithoutCyclops }),
      "p1",
      { instanceId: infiltrator.instanceId, position: infPos },
      makeState({ round: 1, players, board: boardWithoutCyclops })
    );

    const cyclopsAdjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: cyclops.instanceId, position: cyclopsPos }, postState);
    expect(cyclopsAdjustment).toBeCloseTo(-infiltratorOwnRisk);
    expect(cyclopsAdjustment).toBeGreaterThan(0); // protecting a genuinely good swap is a real credit
  });

  it("credits nothing when there's no adjacent own face-down Facestealer to protect", () => {
    const position = { x: 3, y: 3 };
    const cyclops = card("Giant", "p1", true);
    const board: Board = new Map([
      [posKey(position), cyclops],
      [posKey({ x: 2, y: 3 }), card("Warlord", "p2", true)], // a neighbor, but not a Facestealer
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 1, players });
    const postState = makeState({ round: 1, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: cyclops.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });

  it("does not credit protecting an OPPONENT's face-down Facestealer -- only the acting player's own", () => {
    const position = { x: 3, y: 3 };
    const cyclops = card("Giant", "p1", true);
    const board: Board = new Map([
      [posKey(position), cyclops],
      [posKey({ x: 2, y: 3 }), card("Infiltrator", "p2", false)], // an opponent's, not p1's
      [posKey({ x: 2, y: 2 }), card("Warlord", "p1", true)],
    ]);
    const players = [
      { id: "p1", hand: [], isAI: true },
      { id: "p2", hand: [], isAI: true },
    ];
    const preState = makeState({ round: 1, players });
    const postState = makeState({ round: 1, players, board });

    const adjustment = placementHeuristicAdjustment(preState, "p1", { instanceId: cyclops.instanceId, position }, postState);
    expect(adjustment).toBe(0);
  });
});
