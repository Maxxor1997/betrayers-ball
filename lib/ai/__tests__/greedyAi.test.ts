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

  it("prefers flipping an opponent card adjacent to the AI's own Beacon", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p1")); // anchor -- equidistant from both targets
    board.set(posKey({ x: 1, y: 1 }), card("Beacon", "p1")); // known (own); adjacent only to target A
    const targetA = card("Footman", "p2", false);
    const targetB = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 1 }), targetA); // adjacent to the AI's own Beacon -- flipping it helps the AI
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

  it("avoids flipping an opponent card adjacent to an opponent's (revealed) Beacon", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 2, y: 2 }), card("Footman", "p1")); // anchor -- equidistant from both targets
    board.set(posKey({ x: 1, y: 1 }), card("Beacon", "p2", true)); // revealed, so known; adjacent only to target A
    const targetA = card("Footman", "p2", false);
    const targetB = card("Footman", "p2", false);
    board.set(posKey({ x: 2, y: 1 }), targetA); // adjacent to a rival's Beacon -- flipping it helps them, not the AI
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

  it("explores more often when holding a Beacon -- more face-up cards is generally good setup for it", () => {
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

    // Midpoint between BASE_EXPLORATION and the Beacon-in-hand-boosted rate (+0.15) --
    // clears the boosted rate but not the plain baseline.
    const midpoint = () => BASE_EXPLORATION + 0.075;
    const baseline = chooseGreedyAiAction(withoutBeacon, "p1", midpoint);
    const boosted = chooseGreedyAiAction(withBeacon, "p1", midpoint);
    expect(baseline.type).not.toBe("flip");
    expect(boosted.type).toBe("flip");
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

  it("prefers a cell that hits both neighbors for Skysplitter, not just whichever helps against the current leader", () => {
    const board: Board = new Map();
    // Same untouchable-leader trick as the Earthshaker test above, but sealed by
    // *column* instead of row -- Skysplitter only ever checks directly above/below
    // (same column), so a fully-packed column (not row) is what makes p2 unreachable
    // here. (A packed row would leak: every row-1 cell would sit directly below a p2
    // card and become a legitimately better "hit the real leader" option, which is
    // exactly what happened before this was column-sealed instead.)
    for (let y = 0; y < 7; y++) {
      board.set(posKey({ x: 6, y }), card("Giant", "p2", true));
    }
    // A "sandwich" at column 2 -- both above and below the empty middle cell are p3's.
    board.set(posKey({ x: 2, y: 1 }), card("Footman", "p3"));
    board.set(posKey({ x: 2, y: 3 }), card("Footman", "p3"));
    // A lone p3 card elsewhere with nothing below it -- only a single hit available there.
    board.set(posKey({ x: 4, y: 1 }), card("Footman", "p3"));

    const skysplitter = card("Skysplitter", "p1");
    const state = makeState({
      board,
      round: 1,
      players: [
        { id: "p1", hand: [skysplitter], isAI: true },
        { id: "p2", hand: [], isAI: true },
        { id: "p3", hand: [], isAI: true },
      ],
    });

    const action = chooseGreedyAiAction(state, "p1", deterministicRng(1));
    expect(action).toEqual({ type: "place", playerId: "p1", instanceId: skysplitter.instanceId, position: { x: 2, y: 2 } });
  });

  it("prefers hurting a non-leader opponent over an equally-scoring placement that hurts no one, for any card -- not just Earthshaker/Skysplitter", () => {
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
