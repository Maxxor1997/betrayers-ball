import { describe, expect, it } from "vitest";
import { aiVoteProbability, computeAiVote, computeGameResult, estimateMargin, isBoardFull, isRoundCapHit, shouldEndGame } from "../endgame";
import { Board, BoardBounds, CardInstance, GameConfig, GameState, posKey } from "../types";
import { CARD_DEFS } from "@/lib/content/cards";

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
  playerCount: 2,
  aiDifficulty: "medium",
};

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    config: MARGIN_CONFIG,
    board: new Map(),
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
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1"));
    board.set(posKey({ x: 0, y: 1 }), card("Giant", "p2"));
    const result = computeGameResult(board, BOUNDS, 3, ["p1", "p2"]);
    expect(result.scores).toEqual({ p1: CARD_DEFS.Footman.base, p2: CARD_DEFS.Giant.base });
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
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p1", false)); // isolated -> no neighbor penalty
    expect(estimateMargin(makeState({ board }), "p1")).toBe(CARD_DEFS.Exile.base);
  });

  it("does NOT apply an opponent's hidden card's true effect -- uses the neutral placeholder instead", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p2", false)); // hidden from p1; true value would be Exile.base
    // p1 can't see it's an Exile, so it's valued as the flat Unknown placeholder instead.
    expect(estimateMargin(makeState({ board }), "p1")).toBe(0 - CARD_DEFS.Unknown.base);
  });

  it("applies the opponent's true effect once the same card is face-up", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p2", true));
    expect(estimateMargin(makeState({ board }), "p1")).toBe(0 - CARD_DEFS.Exile.base);
  });

  it("resolveBoard (ground truth) and estimateMargin (viewer's estimate) genuinely diverge on hidden cards", () => {
    const board: Board = new Map();
    // 3 isolated, hidden, same-owner Warlords -- Warlord's own penalty only counts a
    // *different* player's Warlords (see cards.ts), so same-owner copies like these
    // don't interact with each other at all; each is worth its full, unpenalized base.
    board.set(posKey({ x: 0, y: 0 }), card("Warlord", "p2", false));
    board.set(posKey({ x: 2, y: 0 }), card("Warlord", "p2", false));
    board.set(posKey({ x: 0, y: 2 }), card("Warlord", "p2", false));
    const state = makeState({ board });

    const trueResult = computeGameResult(board, BOUNDS, state.round, ["p1", "p2"]);
    expect(trueResult.scores.p2).toBe(3 * CARD_DEFS.Warlord.base);

    // p1 can't see any of them are Warlords -- each is estimated as an isolated,
    // effect-free Unknown placeholder (worth less than Warlord's real base), so p1's
    // own estimate is off from the ground truth. That's the point: the estimate never
    // leaks the hidden identity, even though here it happens to underestimate rather
    // than miss a hidden penalty.
    expect(estimateMargin(state, "p1")).toBe(0 - 3 * CARD_DEFS.Unknown.base);
  });

  it("the Unknown placeholder still gets pushed around by a real neighbor's effect", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Exile", "p2", false)); // hidden from p1 -> Unknown placeholder
    board.set(posKey({ x: 1, y: 0 }), card("Bannerman", "p1", true)); // +1 to non-Footman neighbors
    // The placeholder has no printed effect of its own, but it's still a normal
    // neighbor for Bannerman's own effect to land on: p2's Unknown gets +1 from p1's
    // Bannerman, while Bannerman's own value is untouched (its effect only targets
    // neighbors, not itself). On top of that, expectedHiddenNeighborAdjustments now
    // also credits/discounts p1's own Bannerman for whatever that same hidden card
    // might turn out to be once revealed (e.g. a hidden Skysplitter would hit it, a
    // hidden Bannerman would help it) -- see estimateMargin's doc comment. A hidden
    // Earthshaker candidate contributes nothing here: its own valueModifier is now
    // gated on being face-up (see cards.ts), and a still-hidden card is by definition
    // face-down, so this correctly weighs it as having no effect yet, exactly like the
    // genuine article would. Not a round number since it's a deck-composition-weighted
    // average, not a single card's printed rule.
    expect(estimateMargin(makeState({ board }), "p1")).toBeCloseTo(-2.447368421052632);
  });
});

describe("computeAiVote", () => {
  it("is more likely to vote yes the further ahead it is, but never certain", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p1"));
    board.set(posKey({ x: 0, y: 1 }), card("Footman", "p1"));
    const state = makeState({ board }); // p1 ahead 10-0 -> margin 10 -> yes-probability ~0.88, clamped
    expect(computeAiVote(state, "p1", () => 0.5)).toBe(true); // well below the probability
    expect(computeAiVote(state, "p1", () => 0.99)).toBe(false); // even a landslide lead isn't a sure thing
  });

  it("is 50/50 when tied", () => {
    const state = makeState(); // empty board -> 0-0 tie
    expect(computeAiVote(state, "p1", () => 0.05)).toBe(true);
    expect(computeAiVote(state, "p1", () => 0.95)).toBe(false);
  });

  it("is more likely to vote no the further behind it is, but never certain", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p2"));
    const state = makeState({ board }); // p1 behind 0-5 -> margin -5 -> yes-probability ~0.27
    expect(computeAiVote(state, "p1", () => 0.2)).toBe(true); // below the probability
    expect(computeAiVote(state, "p1", () => 0.35)).toBe(false); // above it
  });

  it("ignores the round entirely -- same margin votes the same way regardless", () => {
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Footman", "p2"));
    const early = computeAiVote(makeState({ board, round: 1 }), "p1", () => 0.3);
    const late = computeAiVote(makeState({ board, round: 5 }), "p1", () => 0.3);
    expect(early).toBe(late);
  });

  it("nudges toward voting yes when the player holds a Dying God -- continuing only makes it worse", () => {
    const board: Board = new Map();
    // Dying God's value at round 3 is 10-3=7; an isolated Pretender (no dangerous
    // neighbor to trigger its own penalty) sits at its flat base 7 too -- raw margin
    // ties at 0, which alone would be an exact 50/50 (rng 0.5 -> no, per the tied
    // test above). Dying God's own +1 vote nudge pushes yes-probability to ~0.55,
    // just enough to flip that same rng to yes.
    board.set(posKey({ x: 0, y: 0 }), card("DyingGod", "p1"));
    board.set(posKey({ x: 5, y: 5 }), card("Pretender", "p2"));
    const state = makeState({ board, round: 3 });
    expect(computeAiVote(state, "p1", () => 0.5)).toBe(true);
  });

  it("no longer gives Chronicler (Doomherald) a special vote nudge -- its value isn't round-sensitive anymore", () => {
    // Now that Chronicler is "-3 to adjacent cards while face-up, opponentOnlyFlip"
    // (see lib/content/cards.ts) instead of the old +1/round elapsed, there's nothing
    // round-precise left to credit -- an isolated, face-down Chronicler (own base 3,
    // no effect until flipped) should vote exactly like a flat base-3 card would, with
    // no extra nudge either way.
    const board: Board = new Map();
    board.set(posKey({ x: 0, y: 0 }), card("Chronicler", "p1"));
    board.set(posKey({ x: 5, y: 5 }), card("PlagueBearer", "p2")); // flat base 3, no neighbors to trigger its own effect
    const state = makeState({ board, round: 3 });
    expect(computeAiVote(state, "p1", () => 0.5)).toBe(false); // tied margin (0-0) -> exactly 50/50, rng 0.5 -> no (see the tied test above)
  });

  it("pulls toward no when opponents recently voted yes -- their vote leaks a hidden strength this player's own margin can't see", () => {
    // Tied margin (0-0) would normally be an exact 50/50 (rng 0.5 -> no, per the tied
    // test above); with p1 tied against two opponents who *both* voted yes last round,
    // voteHistoryAdjustment pulls the margin further negative, only reinforcing the
    // already-"no" outcome at rng 0.5 -- flip the assertion around instead, at an rng
    // just below the *unadjusted* 50% line, to prove the adjustment actually moved it.
    const state = makeState({
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
        { id: "p3", hand: [], isAI: true },
      ],
      voteHistory: [{ round: 2, votes: { p1: false, p2: true, p3: true } }],
    });
    expect(computeAiVote(state, "p1", () => 0.49)).toBe(false); // would be "yes" at plain 50/50 (rng < 0.5), but the correction pulls yes-probability below 0.49
  });

  it("pulls toward yes when opponents recently voted no -- nothing suggests this player's margin estimate is missing anything", () => {
    const state = makeState({
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
        { id: "p3", hand: [], isAI: true },
      ],
      voteHistory: [{ round: 2, votes: { p1: true, p2: false, p3: false } }],
    });
    expect(computeAiVote(state, "p1", () => 0.51)).toBe(true); // would be "no" at plain 50/50 (rng >= 0.5), but the correction pushes yes-probability above 0.51
  });

  it("only looks at the most recent tallied round, not the whole history", () => {
    const state = makeState({
      players: [
        { id: "p1", hand: [], isAI: true },
        { id: "p2", hand: [], isAI: true },
      ],
      voteHistory: [
        { round: 1, votes: { p1: false, p2: true } }, // stale -- should have no effect
        { round: 2, votes: { p1: false, p2: false } }, // this is the only one that should count
      ],
    });
    expect(computeAiVote(state, "p1", () => 0.51)).toBe(true); // opponent's most recent vote was "no" -> pulled toward yes, same as the "pulls toward yes" test above
  });

  it("applies no correction before any round has ever been tallied", () => {
    const state = makeState(); // voteHistory: [] -- empty board, tied margin
    expect(computeAiVote(state, "p1", () => 0.5)).toBe(false); // exactly the plain 50/50 behavior, same as the tied test above
  });
});
