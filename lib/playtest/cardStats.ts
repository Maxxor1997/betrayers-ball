import { chooseGreedyAiAction } from "@/lib/ai/greedyAi";
import { ALL_CARD_IDS, CARD_DEFS, copiesForPlayerCount } from "@/lib/content/cards";
import { Rng } from "@/lib/engine/deck";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { FLOORED_AT_ZERO_LABEL, ResolvedCard } from "@/lib/engine/resolution";
import { currentPlayerId } from "@/lib/engine/turns";
import { CardId, CenterEffectId, GameState } from "@/lib/engine/types";

/** Running totals for one card across however many completed games have been tallied -- see statsSummary for the derived per-game averages a UI actually wants. */
export interface CardStats {
  /** Times this card was actually placed on the board and scored -- a card still sitting unplayed in hand at game end never reaches resolveBoard, so it's not counted. */
  played: number;
  /**
   * Sum of copiesForPlayerCount(card, playerCount) across every game tallied, whether
   * or not this particular card ever got drawn or placed -- deck copy counts vary by
   * player count and by card (see CardDef.count), so a card with more printed copies
   * naturally rings up a higher raw `played` count for no interesting reason. Dividing
   * played by this normalizes for that -- see statsSummary's playRate.
   */
  copiesInDeck: number;
  /** Sum of each appearance's "own" value -- base + only this card's own conditional self-effects, floored at 0, deliberately excluding anything a neighbor or center effect did to it. See ownValueFor. */
  ownScoreSum: number;
  /** Sum of each appearance's actual finalValue as scored in-game -- includes everything, same number the game itself totals a player's score from. */
  finalScoreSum: number;
  /** Sum of the owning player's standard-competition placement (1st/2nd/...) in each game this card appeared in. */
  placementSum: number;
  /**
   * Sum of (this placement's rank - placementBaseline(that game's playerCount)), once
   * per appearance -- a raw placement number is meaningless to compare across player
   * counts (1st of 8 and 1st of 2 aren't the same accomplishment, and a flat table
   * blends games from every player count together), so this tracks each appearance's
   * *relative* performance against "if this seat did exactly average for its own
   * game," summed with the correct per-game baseline before any blending happens.
   * See statsSummary's avgPlacementDelta.
   */
  placementDeltaSum: number;
  /** Sum of the ending round number (see OverallStats.roundLengthSum's doc comment) of every game this card appeared in -- once per placement, same weighting as every other per-card sum here. */
  roundLengthSum: number;
}

/** The average standard-competition placement a seat would get in a `playerCount`-player game with zero skill differentiation -- e.g. 2.5 at 4p, 4.5 at 8p. The reference point placementDeltaSum measures every real placement against. */
export function placementBaseline(playerCount: number): number {
  return (playerCount + 1) / 2;
}

/** Running totals that aren't about any one card -- currently just the game-length baseline every card's own avgRoundLength gets compared against. */
export interface OverallStats {
  gamesTallied: number;
  /** Sum of the round each tallied game ended on -- once per game, regardless of how many cards it had. */
  roundLengthSum: number;
}

/** One "slice" of tallied stats -- everything, or scoped to just one player count (see PlaytestStats.byPlayerCount). Both are folded by the same tallyGame/read by the same statsSummary/overallAvgRoundLength, since a per-player-count slice is shaped identically to the all-games total. */
export interface StatsBucket {
  cards: Record<CardId, CardStats>;
  overall: OverallStats;
}

export interface PlaytestStats extends StatsBucket {
  /**
   * The same tally, split out per player count -- lets a UI compare how a card does at
   * 2p vs 8p (e.g. a heatmap) instead of only ever seeing every game blended together.
   * Keyed by playerCount; a count with no games tallied yet simply has no entry (not a
   * zeroed one), so a UI can tell "never run at this count" apart from "run, but every
   * card scored exactly 0" by checking for the key's presence.
   */
  byPlayerCount: Record<number, StatsBucket>;
}

export function createEmptyBucket(): StatsBucket {
  const cards = {} as Record<CardId, CardStats>;
  for (const id of ALL_CARD_IDS) {
    // "Unknown" is the AI-fairness/redaction placeholder, never a real playable card -- see CardId's own doc comment.
    if (id === "Unknown") continue;
    cards[id] = { played: 0, copiesInDeck: 0, ownScoreSum: 0, finalScoreSum: 0, placementSum: 0, placementDeltaSum: 0, roundLengthSum: 0 };
  }
  return { cards, overall: { gamesTallied: 0, roundLengthSum: 0 } };
}

export function createEmptyStats(): PlaytestStats {
  return { ...createEmptyBucket(), byPlayerCount: {} };
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
 * A card's value counting only its own printed rule -- base and its own valueModifier
 * self-effects -- ignoring every delta a neighbor's outgoing effect or a center
 * effect pushed onto it (those are tagged "external", see ScoreContribution.source).
 * The engine's universal floor at 0 (see applyFloors in resolution.ts) is re-applied
 * fresh against this smaller total rather than reusing the breakdown's own
 * FLOORED_AT_ZERO_LABEL entry, since that entry's amount reflects flooring of the
 * *real* (self + external) total, which can floor a card that never would have gone
 * negative on its own rule alone (or vice versa).
 */
export function ownValueFor(card: ResolvedCard): number {
  const ownRawTotal = card.breakdown
    .filter((d) => d.source === "self" && d.label !== FLOORED_AT_ZERO_LABEL)
    .reduce((sum, d) => sum + d.amount, 0);
  return Math.max(0, ownRawTotal);
}

function tallyIntoBucket(
  bucket: StatsBucket,
  resolvedCards: ResolvedCard[],
  scores: Record<string, number>,
  playerCount: number,
  roundsPlayed: number
): void {
  for (const cardId of ALL_CARD_IDS) {
    if (cardId === "Unknown") continue;
    bucket.cards[cardId].copiesInDeck += copiesForPlayerCount(CARD_DEFS[cardId], playerCount);
  }

  bucket.overall.gamesTallied += 1;
  bucket.overall.roundLengthSum += roundsPlayed;

  const ranks = computeRanks(scores);
  const baseline = placementBaseline(playerCount);
  for (const card of resolvedCards) {
    const entry = bucket.cards[card.cardId];
    entry.played += 1;
    entry.ownScoreSum += ownValueFor(card);
    entry.finalScoreSum += card.finalValue;
    const rank = ranks.get(card.ownerId)!;
    entry.placementSum += rank;
    entry.placementDeltaSum += rank - baseline;
    entry.roundLengthSum += roundsPlayed;
  }
}

/**
 * Folds one completed game's resolved board into the running stats table, in place --
 * both the all-games total and the matching per-player-count slice (see
 * PlaytestStats.byPlayerCount). `playerCount` (the game's, not necessarily the UI's
 * *current* config -- stats accumulate across runs that may have used different
 * settings) determines how many copies of every card existed in that game's deck, for
 * the copiesInDeck tally every card gets regardless of whether it was actually
 * drawn/placed this game. `roundsPlayed` is the round the game ended on
 * (GameState.round at "ended" -- the engine never increments it past the last round
 * actually played, see game.ts's advanceTurn).
 */
export function tallyGame(
  stats: PlaytestStats,
  resolvedCards: ResolvedCard[],
  scores: Record<string, number>,
  playerCount: number,
  roundsPlayed: number
): void {
  tallyIntoBucket(stats, resolvedCards, scores, playerCount, roundsPlayed);
  if (!stats.byPlayerCount[playerCount]) stats.byPlayerCount[playerCount] = createEmptyBucket();
  tallyIntoBucket(stats.byPlayerCount[playerCount], resolvedCards, scores, playerCount, roundsPlayed);
}

export interface CardStatsRow {
  cardId: CardId;
  played: number;
  copiesInDeck: number;
  /** played / copiesInDeck -- what fraction of every copy of this card that ever existed across the tallied games actually made it onto the board, independent of how many copies it happens to print. Null (not 0) if this card has never had a single copy in any tallied game's deck (e.g. it's disabled at every player count simulated so far). */
  playRate: number | null;
  avgOwnScore: number | null;
  avgFinalScore: number | null;
  avgPlacement: number | null;
  /**
   * Average (rank - placementBaseline(that game's playerCount)) across every
   * appearance -- negative means this card's owner placed better than a random seat
   * would on average, positive means worse. Unlike avgPlacement, this is meaningful to
   * compare across cards even when they were tallied across a mix of player counts,
   * since each appearance is measured against its own game's baseline before being
   * summed.
   */
  avgPlacementDelta: number | null;
  /** Average ending round of games this card appeared in -- compare against overallAvgRoundLength to see whether this card tends to show up in longer or shorter games than average. */
  avgRoundLength: number | null;
}

/** Derived per-card averages for display -- null (not 0) for a card that's never been played, so a UI can render "—" instead of a misleading 0. Takes any StatsBucket -- the all-games total or one player count's slice are shaped identically. */
export function statsSummary(bucket: StatsBucket): CardStatsRow[] {
  return ALL_CARD_IDS.filter((id) => id !== "Unknown").map((cardId) => {
    const s = bucket.cards[cardId];
    return {
      cardId,
      played: s.played,
      copiesInDeck: s.copiesInDeck,
      playRate: s.copiesInDeck === 0 ? null : s.played / s.copiesInDeck,
      avgOwnScore: s.played === 0 ? null : s.ownScoreSum / s.played,
      avgFinalScore: s.played === 0 ? null : s.finalScoreSum / s.played,
      avgPlacement: s.played === 0 ? null : s.placementSum / s.played,
      avgPlacementDelta: s.played === 0 ? null : s.placementDeltaSum / s.played,
      avgRoundLength: s.played === 0 ? null : s.roundLengthSum / s.played,
    };
  });
}

/** Baseline "how long do tallied games last, on average" -- independent of any one card, for comparison against each card's own avgRoundLength. Null (not 0) if nothing's been tallied yet. Takes any StatsBucket, same as statsSummary. */
export function overallAvgRoundLength(bucket: StatsBucket): number | null {
  return bucket.overall.gamesTallied === 0 ? null : bucket.overall.roundLengthSum / bucket.overall.gamesTallied;
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
