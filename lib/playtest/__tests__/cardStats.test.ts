import { describe, expect, it } from "vitest";
import { CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { resolveBoard } from "@/lib/engine/resolution";
import { Board, BoardBounds, CardId, CardInstance, posKey } from "@/lib/engine/types";
import {
  computeRanks,
  createEmptyStats,
  disruptionFor,
  overallAvgFlipRate,
  overallAvgRoundLength,
  ownValueFor,
  placementBaseline,
  placementMaxDeviation,
  simulateOneGame,
  simulateOneGameSteps,
  statsSummary,
  tallyGame,
} from "../cardStats";

const BOUNDS: BoardBounds = { width: 9, height: 9, center: { x: 4, y: 4 } };

let counter = 0;
function place(board: Board, x: number, y: number, cardId: CardId, ownerId: string, faceUp = false): CardInstance {
  const c: CardInstance = { instanceId: `c${counter++}`, cardId, ownerId, faceUp };
  board.set(posKey({ x, y }), c);
  return c;
}

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe("computeRanks", () => {
  it("gives a unique rank to strictly-ordered scores", () => {
    const ranks = computeRanks({ a: 10, b: 5, c: 8 });
    expect(ranks.get("a")).toBe(1);
    expect(ranks.get("c")).toBe(2);
    expect(ranks.get("b")).toBe(3);
  });

  it("ties share a rank and compress the ranks below them (1, 1, 3)", () => {
    const ranks = computeRanks({ a: 10, b: 10, c: 5 });
    expect(ranks.get("a")).toBe(1);
    expect(ranks.get("b")).toBe(1);
    expect(ranks.get("c")).toBe(3);
  });
});

describe("placementBaseline", () => {
  it("is the average rank in a playerCount-player game with no skill differentiation", () => {
    expect(placementBaseline(2)).toBe(1.5);
    expect(placementBaseline(4)).toBe(2.5);
    expect(placementBaseline(8)).toBe(4.5);
  });
});

describe("placementMaxDeviation", () => {
  it("is half the game's rank spread -- the furthest a rank can land from baseline", () => {
    expect(placementMaxDeviation(2)).toBe(0.5);
    expect(placementMaxDeviation(4)).toBe(1.5);
    expect(placementMaxDeviation(8)).toBe(3.5);
  });
});

describe("ownValueFor", () => {
  it("counts a card's own self-effect but not a neighbor's outgoing effect on it", () => {
    const board: Board = new Map();
    const banner = place(board, 0, 0, "Bannerman", "p1");
    const warlord = place(board, 1, 0, "Warlord", "p2"); // single Warlord -- its own valueModifier never fires
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolvedWarlord = cards.find((c) => c.instanceId === warlord.instanceId)!;
    // Bannerman gives a non-Footman neighbor +1 -- an external bonus from Warlord's POV.
    expect(resolvedWarlord.finalValue).toBe(CARD_DEFS.Warlord.base + 1);
    expect(ownValueFor(resolvedWarlord)).toBe(CARD_DEFS.Warlord.base);

    const resolvedBanner = cards.find((c) => c.instanceId === banner.instanceId)!;
    // Bannerman has no self-effect of its own -- own value is just its base either way.
    expect(ownValueFor(resolvedBanner)).toBe(CARD_DEFS.Bannerman.base);
  });

  it("counts a card's own conditional self-effect in its own value", () => {
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Warlord", "p1");
    place(board, 2, 0, "Giant", "p1");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = cards.find((c) => c.instanceId === f0.instanceId)!;
    // 3+ owned in row -- Footman's own +1 self-effect.
    expect(resolved.finalValue).toBe(CARD_DEFS.Footman.base + 1);
    expect(ownValueFor(resolved)).toBe(CARD_DEFS.Footman.base + 1);
  });

  it("re-applies the universal floor-at-0 fresh against the own-only total, not the breakdown's real-total floor entry", () => {
    const board: Board = new Map();
    // A lone Warlord has no self-penalty (needs another Warlord to fire) -- own value
    // stays at base. Six Bannermen-worth of external damage would floor the *real*
    // total, but that's not this card's own rule doing the flooring.
    const banner = place(board, 1, 0, "Exile", "p2"); // Exile has a self-penalty from neighbors
    place(board, 0, 0, "Bannerman", "p1"); // +1 external, doesn't offset Exile's own neighbor penalty
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = cards.find((c) => c.instanceId === banner.instanceId)!;
    // Exile: base - 1*neighbors(1) = base - 1, plus Bannerman's external +1 -> real final.
    expect(resolved.finalValue).toBe(CARD_DEFS.Exile.base - 1 + 1);
    // Own value ignores the external +1 entirely: base - 1, floored at 0 only if negative.
    expect(ownValueFor(resolved)).toBe(Math.max(0, CARD_DEFS.Exile.base - 1));
  });
});

describe("disruptionFor", () => {
  it("is 0 for a card with no outgoing effect at all", () => {
    const board: Board = new Map();
    const f = place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Warlord", "p2");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = cards.find((c) => c.instanceId === f.instanceId)!;
    expect(disruptionFor(resolved, cards)).toBe(0);
  });

  it("is positive for damage dealt to an opponent's card", () => {
    const board: Board = new Map();
    const e = place(board, 1, 1, "Earthshaker", "p1");
    place(board, 0, 1, "Footman", "p2"); // same row -- takes Earthshaker's -2
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = cards.find((c) => c.instanceId === e.instanceId)!;
    expect(disruptionFor(resolved, cards)).toBe(2); // 0 (own) - (-2) (opponent) = 2
  });

  it("subtracts damage dealt to the source's own side", () => {
    const board: Board = new Map();
    const e = place(board, 1, 1, "Earthshaker", "p1");
    place(board, 0, 1, "Footman", "p2"); // opponent, same row
    place(board, 3, 1, "Footman", "p1"); // own side, same row -- also takes the -2
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = cards.find((c) => c.instanceId === e.instanceId)!;
    // -2 (own) - (-2) (opponent) = 0 -- hurting your own side as much as the opponent
    // is a net-neutral disruption, not a genuinely effective one.
    expect(disruptionFor(resolved, cards)).toBe(0);
  });

  it("attributes damage to the correct instance when two copies of the same disruptive card are both on the board", () => {
    const board: Board = new Map();
    // Two Earthshakers, different owners, same row -- each hits every *other* card in
    // the row, including each other, plus a third neutral target.
    const e1 = place(board, 0, 1, "Earthshaker", "p1");
    const e2 = place(board, 1, 1, "Earthshaker", "p2");
    const target = place(board, 2, 1, "Footman", "p3");
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolvedE1 = cards.find((c) => c.instanceId === e1.instanceId)!;
    const resolvedE2 = cards.find((c) => c.instanceId === e2.instanceId)!;
    const resolvedTarget = cards.find((c) => c.instanceId === target.instanceId)!;
    // Each Earthshaker hits the other Earthshaker (-2, opponent) and the target (-2,
    // opponent) -- 4 total disruption apiece, not double-counted or mixed up between
    // the two sources despite sharing a cardId and an identical label.
    expect(disruptionFor(resolvedE1, cards)).toBe(4);
    expect(disruptionFor(resolvedE2, cards)).toBe(4);
    expect(disruptionFor(resolvedTarget, cards)).toBe(0); // it has no outgoing effect of its own
  });
});

describe("tallyGame", () => {
  it("accumulates played count, own/final score sums, and placement across resolved cards", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1", true);
    const w0 = place(board, 1, 0, "Warlord", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    tallyGame(stats, cards, { p1: 100, p2: 50 }, 2, 3);

    expect(stats.cards.Footman.played).toBe(1);
    expect(stats.cards.Footman.finalScoreSum).toBe(cards.find((c) => c.instanceId === f0.instanceId)!.finalValue);
    expect(stats.cards.Footman.placementSum).toBe(1); // p1 has the higher score -> 1st

    expect(stats.cards.Warlord.played).toBe(1);
    expect(stats.cards.Warlord.finalScoreSum).toBe(cards.find((c) => c.instanceId === w0.instanceId)!.finalValue);
    expect(stats.cards.Warlord.placementSum).toBe(2); // p2 -> 2nd

    // Untouched cards stay at zero.
    expect(stats.cards.Giant.played).toBe(0);
  });

  it("tallies placementDeltaSum against that game's own player-count baseline and scale, not a global one", () => {
    const stats = createEmptyStats();
    const board2p: Board = new Map();
    place(board2p, 0, 0, "Footman", "p1");
    place(board2p, 1, 0, "Warlord", "p2");
    // p1 (Footman) wins -> rank 1; p2 (Warlord) -> rank 2. Baseline at 2p is 1.5, max deviation 0.5.
    tallyGame(stats, resolveBoard(board2p, BOUNDS, 3).cards, { p1: 100, p2: 50 }, 2, 3);
    expect(stats.cards.Footman.placementDeltaSum).toBeCloseTo((1 - placementBaseline(2)) / placementMaxDeviation(2)); // -1 (best possible finish)
    expect(stats.cards.Warlord.placementDeltaSum).toBeCloseTo((2 - placementBaseline(2)) / placementMaxDeviation(2)); // +1 (worst possible finish)

    // Same rank-1 finish, but at 8p -- despite the much bigger raw baseline gap, the
    // normalized delta should land at exactly the same -1 (best possible finish at any
    // player count), not some larger magnitude just because there were more seats.
    const board8p: Board = new Map();
    place(board8p, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board8p, BOUNDS, 3).cards, { p1: 100 }, 8, 3);
    expect(stats.cards.Footman.placementDeltaSum).toBeCloseTo(-2); // -1 (2p) + -1 (8p)
  });

  it("accumulates across multiple games", () => {
    const stats = createEmptyStats();
    const board1: Board = new Map();
    place(board1, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board1, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    const board2: Board = new Map();
    place(board2, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board2, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    expect(stats.cards.Footman.played).toBe(2);
  });

  it("tallies copiesInDeck for every card at the game's player count, even ones never drawn/placed", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10 }, 4, 3);

    expect(stats.cards.Footman.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Footman, 4));
    // Giant was never placed this game, but still had copies in that game's deck.
    expect(stats.cards.Giant.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Giant, 4));
  });

  it("accumulates copiesInDeck across games with different player counts", () => {
    const stats = createEmptyStats();
    tallyGame(stats, [], { p1: 0 }, 2, 3);
    tallyGame(stats, [], { p1: 0 }, 5, 3);

    expect(stats.cards.Footman.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Footman, 2) + copiesForPlayerCount(CARD_DEFS.Footman, 5));
  });

  it("tallies roundLengthSum per card (once per placement) and overall gamesTallied/roundLengthSum (once per game)", () => {
    const stats = createEmptyStats();
    const board1: Board = new Map();
    place(board1, 0, 0, "Footman", "p1");
    place(board1, 1, 0, "Warlord", "p2");
    tallyGame(stats, resolveBoard(board1, BOUNDS, 3).cards, { p1: 10, p2: 5 }, 2, 4);

    const board2: Board = new Map();
    place(board2, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board2, BOUNDS, 3).cards, { p1: 10 }, 2, 6);

    // Footman appeared in both games (rounds 4 and 6); Warlord only in the first (round 4).
    expect(stats.cards.Footman.roundLengthSum).toBe(4 + 6);
    expect(stats.cards.Warlord.roundLengthSum).toBe(4);

    // Overall is per-game, not per-placement -- two games tallied, not three.
    expect(stats.overall.gamesTallied).toBe(2);
    expect(stats.overall.roundLengthSum).toBe(4 + 6);
  });

  it("also folds into the matching per-player-count slice, alongside the all-games total", () => {
    const stats = createEmptyStats();
    const board2p: Board = new Map();
    place(board2p, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board2p, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    const board4p: Board = new Map();
    place(board4p, 0, 0, "Footman", "p1");
    place(board4p, 1, 0, "Footman", "p2");
    tallyGame(stats, resolveBoard(board4p, BOUNDS, 3).cards, { p1: 10, p2: 20 }, 4, 5);

    // All-games total blends both.
    expect(stats.cards.Footman.played).toBe(3);
    // Each player count's slice only has its own games.
    expect(stats.byPlayerCount[2].cards.Footman.played).toBe(1);
    expect(stats.byPlayerCount[2].overall.gamesTallied).toBe(1);
    expect(stats.byPlayerCount[4].cards.Footman.played).toBe(2);
    expect(stats.byPlayerCount[4].overall.gamesTallied).toBe(1);
    // A player count never tallied has no entry at all (not a zeroed one).
    expect(stats.byPlayerCount[6]).toBeUndefined();
  });

  it("tallies disruptionSum per appearance, divided by that game's opponent count", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    place(board, 1, 1, "Earthshaker", "p1");
    place(board, 0, 1, "Footman", "p2"); // same row -- takes the -2
    // 3 players -> 2 opponents; raw disruption is 2 (see disruptionFor's tests above).
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10, p2: 5, p3: 0 }, 3, 3);
    expect(stats.cards.Earthshaker.disruptionSum).toBeCloseTo(2 / 2);
  });
});

describe("statsSummary / overallAvgRoundLength on a per-player-count slice", () => {
  it("reads a byPlayerCount entry the same way as the all-games total, since both are StatsBuckets", () => {
    const stats = createEmptyStats();
    const board2p: Board = new Map();
    place(board2p, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board2p, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    const board4p: Board = new Map();
    place(board4p, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board4p, BOUNDS, 3).cards, { p1: 10 }, 4, 7);

    const rows2p = statsSummary(stats.byPlayerCount[2]);
    expect(rows2p.find((r) => r.cardId === "Footman")!.avgRoundLength).toBe(3);
    expect(overallAvgRoundLength(stats.byPlayerCount[2])).toBe(3);

    const rows4p = statsSummary(stats.byPlayerCount[4]);
    expect(rows4p.find((r) => r.cardId === "Footman")!.avgRoundLength).toBe(7);
    expect(overallAvgRoundLength(stats.byPlayerCount[4])).toBe(7);

    // The blended total still averages across both.
    expect(overallAvgRoundLength(stats)).toBe(5);
  });
});

describe("statsSummary", () => {
  it("reports null averages (not 0/NaN) for a card that's never been played", () => {
    const rows = statsSummary(createEmptyStats());
    const footman = rows.find((r) => r.cardId === "Footman")!;
    expect(footman.played).toBe(0);
    expect(footman.playRate).toBeNull(); // never had a single copy in a tallied deck either
    expect(footman.avgOwnScore).toBeNull();
    expect(footman.avgFinalScore).toBeNull();
    expect(footman.avgPlacement).toBeNull();
    expect(footman.avgPlacementDelta).toBeNull();
    expect(footman.avgRoundLength).toBeNull();
    expect(footman.avgDisruption).toBeNull();
  });

  it("averages sums over played count once a card has appeared", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p2");
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10, p2: 20 }, 2, 3);

    const row = statsSummary(stats).find((r) => r.cardId === "Footman")!;
    expect(row.played).toBe(2);
    expect(row.avgPlacement).toBe(1.5); // one 1st (p2), one 2nd (p1)
    expect(row.avgPlacementDelta).toBe(0); // exactly the 2p baseline (1.5) on average -- delta of 0
    expect(row.avgRoundLength).toBe(3);
    expect(row.avgDisruption).toBe(0); // played, but Footman has no outgoing effect -- 0, not null
  });

  it("avgPlacementDelta stays comparable across a mix of player counts, unlike avgPlacement", () => {
    const stats = createEmptyStats();
    // Two 1st-place finishes for Footman: one at 2p, one at 8p. avgPlacement can't tell
    // these apart (both contribute a bare rank of 1); avgPlacementDelta should treat
    // them as equally strong (both -1, the best possible finish at any player count),
    // not weight the 8p one as a bigger accomplishment just because there were more seats.
    const board2p: Board = new Map();
    place(board2p, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board2p, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    const board8p: Board = new Map();
    place(board8p, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board8p, BOUNDS, 3).cards, { p1: 10 }, 8, 3);

    const row = statsSummary(stats).find((r) => r.cardId === "Footman")!;
    expect(row.avgPlacement).toBe(1); // both appearances were rank 1
    expect(row.avgPlacementDelta).toBeCloseTo(-1);
  });

  it("computes playRate as played divided by copies-in-deck, scaling for cards with different print counts", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10 }, 4, 3);

    const row = statsSummary(stats).find((r) => r.cardId === "Footman")!;
    expect(row.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Footman, 4));
    expect(row.playRate).toBe(1 / copiesForPlayerCount(CARD_DEFS.Footman, 4));
  });

  it("never includes the Unknown pseudo-card", () => {
    const rows = statsSummary(createEmptyStats());
    expect(rows.some((r) => r.cardId === "Unknown")).toBe(false);
  });

  it("computes flipRate as the fraction of appearances that are face-up at game end", () => {
    const stats = createEmptyStats();
    const boardUp: Board = new Map();
    place(boardUp, 0, 0, "Footman", "p1", true);
    tallyGame(stats, resolveBoard(boardUp, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    const boardDown: Board = new Map();
    place(boardDown, 0, 0, "Footman", "p1", false);
    tallyGame(stats, resolveBoard(boardDown, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    const row = statsSummary(stats).find((r) => r.cardId === "Footman")!;
    expect(row.flipRate).toBe(0.5); // 1 of 2 appearances face-up
  });

  it("gives a forceFaceUp card a flip rate of exactly 1 -- it's always known, never actually flipped", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    // forceFaceUp (see lib/content/cards.ts) is enforced by applyPlace at placement
    // time, not by resolveBoard -- by the time a card reaches resolution its faceUp
    // is already whatever placement settled on, so a Giant is placed face-up directly
    // here rather than relying on that placement-time rule this resolution-level test
    // doesn't go through.
    place(board, 0, 0, "Giant", "p1", true);
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10 }, 2, 3);

    const row = statsSummary(stats).find((r) => r.cardId === "Giant")!;
    expect(row.flipRate).toBe(1);
  });

  it("flipRate is null (not 0) for a card that's never been played", () => {
    const row = statsSummary(createEmptyStats()).find((r) => r.cardId === "Footman")!;
    expect(row.flipRate).toBeNull();
  });
});

describe("overallAvgRoundLength", () => {
  it("is null before anything's been tallied", () => {
    expect(overallAvgRoundLength(createEmptyStats())).toBeNull();
  });

  it("averages the ending round across every tallied game, regardless of card count", () => {
    const stats = createEmptyStats();
    tallyGame(stats, [], { p1: 0 }, 2, 2);
    tallyGame(stats, [], { p1: 0 }, 2, 8);
    expect(overallAvgRoundLength(stats)).toBe(5);
  });
});

describe("overallAvgFlipRate", () => {
  it("is null before anything's been tallied", () => {
    expect(overallAvgFlipRate(createEmptyStats())).toBeNull();
  });

  it("averages the face-up fraction of the board across every tallied game", () => {
    const stats = createEmptyStats();
    const allUp: Board = new Map();
    place(allUp, 0, 0, "Footman", "p1", true);
    place(allUp, 1, 0, "Warlord", "p2", true);
    tallyGame(stats, resolveBoard(allUp, BOUNDS, 3).cards, { p1: 10, p2: 5 }, 2, 3); // 2/2 face-up

    const halfUp: Board = new Map();
    place(halfUp, 0, 0, "Footman", "p1", true);
    place(halfUp, 1, 0, "Warlord", "p2", false);
    tallyGame(stats, resolveBoard(halfUp, BOUNDS, 3).cards, { p1: 10, p2: 5 }, 2, 3); // 1/2 face-up

    expect(overallAvgFlipRate(stats)).toBeCloseTo((1 + 0.5) / 2);
  });

  it("doesn't divide by zero for a game with no cards on the board", () => {
    const stats = createEmptyStats();
    tallyGame(stats, [], { p1: 0 }, 2, 2);
    expect(overallAvgFlipRate(stats)).toBe(0);
  });
});

describe("simulateOneGame", () => {
  it("plays an all-AI game to completion with a real result, deterministically for a fixed seed", () => {
    const state = simulateOneGame(3, "none", deterministicRng(7));
    expect(state.phase).toBe("ended");
    expect(state.result).not.toBeNull();
    expect(Object.keys(state.result!.scores)).toHaveLength(3);
    expect(state.players.every((p) => p.isAI)).toBe(true);
  });

  it("never gets stuck in voting -- the all-AI vote-tally fix (game.ts) is what makes this loop terminate", () => {
    // roundCap alone would already guarantee termination, but this specifically
    // exercises the min-round-floor voting path with zero human players.
    const state = simulateOneGame(2, "none", deterministicRng(3));
    expect(state.phase).toBe("ended");
  });
});

describe("simulateOneGameSteps", () => {
  it("yields an intermediate (still-playing) state before eventually finishing, and the plain wrapper matches its own final state for the same seed", () => {
    const steps = [...simulateOneGameSteps(3, "none", deterministicRng(7))];
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.some((s) => s.phase === "playing")).toBe(true);
    const last = steps[steps.length - 1];
    expect(last.phase).toBe("ended");

    // simulateOneGame is just this generator drained to its return value -- same seed,
    // same shape of result. (Not a deep toEqual: card instanceIds come from a
    // module-level counter shared across the whole test file, not the seeded rng, so
    // they aren't reproducible run-to-run even with an identical seed.)
    const rerun = simulateOneGame(3, "none", deterministicRng(7));
    expect(rerun.phase).toBe(last.phase);
    expect(rerun.round).toBe(last.round);
    expect(rerun.result).toEqual(last.result);
  });
});
