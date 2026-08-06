import { chooseGreedyAiAction } from "@/lib/ai/greedyAi";
import { ALL_CARD_IDS, CARD_DEFS } from "@/lib/content/cards";
import { Rng } from "@/lib/engine/deck";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { FLOORED_AT_ZERO_LABEL, ResolvedCard } from "@/lib/engine/resolution";
import { currentPlayerId } from "@/lib/engine/turns";
import { CardId, CenterEffectId, GameState } from "@/lib/engine/types";

/** Running totals for one card across however many completed games have been tallied -- see statsSummary for the derived per-game averages a UI actually wants. */
export interface CardStats {
  /** Times this card was actually placed on the board and scored -- a card still sitting unplayed in hand at game end never reaches resolveBoard, so it's not counted. */
  played: number;
  /** Sum of each appearance's "own" value -- base + only this card's own conditional self-effects and its own floorAtZero, deliberately excluding anything a neighbor or center effect did to it. See ownValueFor. */
  ownScoreSum: number;
  /** Sum of each appearance's actual finalValue as scored in-game -- includes everything, same number the game itself totals a player's score from. */
  finalScoreSum: number;
  /** Sum of the owning player's standard-competition placement (1st/2nd/...) in each game this card appeared in. */
  placementSum: number;
}

export function createEmptyStats(): Record<CardId, CardStats> {
  const stats = {} as Record<CardId, CardStats>;
  for (const id of ALL_CARD_IDS) {
    // "Unknown" is the AI-fairness/redaction placeholder, never a real playable card -- see CardId's own doc comment.
    if (id === "Unknown") continue;
    stats[id] = { played: 0, ownScoreSum: 0, finalScoreSum: 0, placementSum: 0 };
  }
  return stats;
}

/**
 * Standard competition ranking (1, 2, 2, 4 -- a tie doesn't compress the ranks below
 * it), highest score first -- same rule EndScreen.tsx's placeLabel uses for the
 * end-of-game summary, duplicated here rather than imported since that's a "use
 * client" component and this module needs to stay usable from a plain script/effect.
 */
export function computeRanks(scores: Record<string, number>): Map<string, number> {
  const ids = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  const ranks = new Map<string, number>();
  ids.forEach((id, i) => {
    const rank = i === 0 || scores[id] !== scores[ids[i - 1]] ? i + 1 : ranks.get(ids[i - 1])!;
    ranks.set(id, rank);
  });
  return ranks;
}

/**
 * A card's value counting only its own printed rule -- base, its own valueModifier
 * self-effects, and its own floorAtZero -- ignoring every delta a neighbor's outgoing
 * effect or a center effect pushed onto it (those are tagged "external", see
 * ScoreContribution.source). The floor is re-applied fresh against this smaller total
 * rather than reusing the breakdown's own FLOORED_AT_ZERO_LABEL entry, since that
 * entry's amount reflects flooring of the *real* (self + external) total, which can
 * floor a card that never would have gone negative on its own rule alone (or vice
 * versa).
 */
export function ownValueFor(card: ResolvedCard): number {
  const ownRawTotal = card.breakdown
    .filter((d) => d.source === "self" && d.label !== FLOORED_AT_ZERO_LABEL)
    .reduce((sum, d) => sum + d.amount, 0);
  return CARD_DEFS[card.cardId].floorAtZero ? Math.max(0, ownRawTotal) : ownRawTotal;
}

/** Folds one completed game's resolved board into the running stats table, in place. */
export function tallyGame(stats: Record<CardId, CardStats>, resolvedCards: ResolvedCard[], scores: Record<string, number>): void {
  const ranks = computeRanks(scores);
  for (const card of resolvedCards) {
    const entry = stats[card.cardId];
    entry.played += 1;
    entry.ownScoreSum += ownValueFor(card);
    entry.finalScoreSum += card.finalValue;
    entry.placementSum += ranks.get(card.ownerId)!;
  }
}

export interface CardStatsRow {
  cardId: CardId;
  played: number;
  avgOwnScore: number | null;
  avgFinalScore: number | null;
  avgPlacement: number | null;
}

/** Derived per-card averages for display -- null (not 0) for a card that's never been played, so a UI can render "—" instead of a misleading 0. */
export function statsSummary(stats: Record<CardId, CardStats>): CardStatsRow[] {
  return ALL_CARD_IDS.filter((id) => id !== "Unknown").map((cardId) => {
    const s = stats[cardId];
    return {
      cardId,
      played: s.played,
      avgOwnScore: s.played === 0 ? null : s.ownScoreSum / s.played,
      avgFinalScore: s.played === 0 ? null : s.finalScoreSum / s.played,
      avgPlacement: s.played === 0 ? null : s.placementSum / s.played,
    };
  });
}

/**
 * Plays one full game entirely with AI (greedy heuristic) players to completion,
 * yielding the state after every single action -- lets a caller (the playtest page's
 * "watch games simulate" mode) sample and render intermediate boards instead of only
 * ever seeing a finished one. Every seat is AI, so every round-boundary vote fills and
 * tallies itself within the same advanceTurn call (see game.ts's tallyVotes) -- the
 * loop never needs to special-case "voting", it just runs until phase flips to
 * "ended". `simulateOneGame` below is the plain (non-stepped) equivalent for bulk runs
 * that don't need to observe intermediate states.
 */
export function* simulateOneGameSteps(playerCount: number, centerEffect: CenterEffectId, rng: Rng): Generator<GameState, GameState, void> {
  const playerIds = Array.from({ length: playerCount }, (_, i) => `sim${i}`);
  const config = configForPlayerCount(playerCount, centerEffect);
  const firstPlayerIndex = Math.floor(rng() * playerIds.length);
  let state = createGame(playerIds, config, rng, playerIds, firstPlayerIndex);

  while (state.phase === "playing") {
    const activeId = currentPlayerId(state);
    const action = chooseGreedyAiAction(state, activeId, rng);
    state = applyAction(state, action, rng);
    yield state;
  }
  return state;
}

/** Plain (non-stepped) equivalent of simulateOneGameSteps -- for bulk runs that only need the finished game. */
export function simulateOneGame(playerCount: number, centerEffect: CenterEffectId, rng: Rng): GameState {
  const gen = simulateOneGameSteps(playerCount, centerEffect, rng);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}
