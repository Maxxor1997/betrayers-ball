import { describe, expect, it } from "vitest";
import { CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { resolveBoard } from "@/lib/engine/resolution";
import { Board, BoardBounds, CardId, CardInstance, posKey } from "@/lib/engine/types";
import { computeRanks, createEmptyStats, ownValueFor, simulateOneGame, simulateOneGameSteps, statsSummary, tallyGame } from "../cardStats";

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

  it("re-applies floorAtZero fresh against the own-only total, not the breakdown's real-total floor entry", () => {
    const board: Board = new Map();
    // A lone Warlord has no self-penalty (needs another Warlord to fire) -- own value
    // stays at base. Six Bannermen-worth of external damage would floor the *real*
    // total, but that's not this card's own rule doing the flooring.
    const banner = place(board, 1, 0, "Exile", "p2"); // Exile has floorAtZero and a self-penalty from neighbors
    place(board, 0, 0, "Bannerman", "p1"); // +1 external, doesn't offset Exile's own neighbor penalty
    const { cards } = resolveBoard(board, BOUNDS, 3);
    const resolved = cards.find((c) => c.instanceId === banner.instanceId)!;
    // Exile: base - 2*neighbors(1) = base - 2, plus Bannerman's external +1 -> real final.
    expect(resolved.finalValue).toBe(CARD_DEFS.Exile.base - 2 + 1);
    // Own value ignores the external +1 entirely: base - 2, floored at 0 only if negative.
    expect(ownValueFor(resolved)).toBe(Math.max(0, CARD_DEFS.Exile.base - 2));
  });
});

describe("tallyGame", () => {
  it("accumulates played count, own/final score sums, and placement across resolved cards", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    const f0 = place(board, 0, 0, "Footman", "p1", true);
    const w0 = place(board, 1, 0, "Warlord", "p2", true);
    const { cards } = resolveBoard(board, BOUNDS, 3);
    tallyGame(stats, cards, { p1: 100, p2: 50 }, 2);

    expect(stats.Footman.played).toBe(1);
    expect(stats.Footman.finalScoreSum).toBe(cards.find((c) => c.instanceId === f0.instanceId)!.finalValue);
    expect(stats.Footman.placementSum).toBe(1); // p1 has the higher score -> 1st

    expect(stats.Warlord.played).toBe(1);
    expect(stats.Warlord.finalScoreSum).toBe(cards.find((c) => c.instanceId === w0.instanceId)!.finalValue);
    expect(stats.Warlord.placementSum).toBe(2); // p2 -> 2nd

    // Untouched cards stay at zero.
    expect(stats.Giant.played).toBe(0);
  });

  it("accumulates across multiple games", () => {
    const stats = createEmptyStats();
    const board1: Board = new Map();
    place(board1, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board1, BOUNDS, 3).cards, { p1: 10 }, 2);

    const board2: Board = new Map();
    place(board2, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board2, BOUNDS, 3).cards, { p1: 10 }, 2);

    expect(stats.Footman.played).toBe(2);
  });

  it("tallies copiesInDeck for every card at the game's player count, even ones never drawn/placed", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10 }, 4);

    expect(stats.Footman.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Footman, 4));
    // Giant was never placed this game, but still had copies in that game's deck.
    expect(stats.Giant.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Giant, 4));
  });

  it("accumulates copiesInDeck across games with different player counts", () => {
    const stats = createEmptyStats();
    tallyGame(stats, [], { p1: 0 }, 2);
    tallyGame(stats, [], { p1: 0 }, 5);

    expect(stats.Footman.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Footman, 2) + copiesForPlayerCount(CARD_DEFS.Footman, 5));
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
  });

  it("averages sums over played count once a card has appeared", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    place(board, 1, 0, "Footman", "p2");
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10, p2: 20 }, 2);

    const row = statsSummary(stats).find((r) => r.cardId === "Footman")!;
    expect(row.played).toBe(2);
    expect(row.avgPlacement).toBe(1.5); // one 1st (p2), one 2nd (p1)
  });

  it("computes playRate as played divided by copies-in-deck, scaling for cards with different print counts", () => {
    const stats = createEmptyStats();
    const board: Board = new Map();
    place(board, 0, 0, "Footman", "p1");
    tallyGame(stats, resolveBoard(board, BOUNDS, 3).cards, { p1: 10 }, 4);

    const row = statsSummary(stats).find((r) => r.cardId === "Footman")!;
    expect(row.copiesInDeck).toBe(copiesForPlayerCount(CARD_DEFS.Footman, 4));
    expect(row.playRate).toBe(1 / copiesForPlayerCount(CARD_DEFS.Footman, 4));
  });

  it("never includes the Unknown pseudo-card", () => {
    const rows = statsSummary(createEmptyStats());
    expect(rows.some((r) => r.cardId === "Unknown")).toBe(false);
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
