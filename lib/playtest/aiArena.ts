import { chooseAiActionForDifficulty, computeVoteForDifficulty } from "@/lib/ai/difficulty";
import { chooseGreedyAiAction } from "@/lib/ai/greedyAi";
import { benchmarkTimings, chooseExpertVote, chooseHardFastAction, DEFAULT_HARD_FAST_OPTIONS, HardFastOptions } from "@/lib/ai/hardFast";
import { chooseRandomAiAction } from "@/lib/ai/randomAi";
import { chooseTwoPlyAction, DEFAULT_TWO_PLY_OPTIONS, twoPlySearchStats, TwoPlyOptions } from "@/lib/ai/twoPly";
import { computeAiVote } from "@/lib/engine/endgame";
import { applyAction, ComputeVoteFn, configForPlayerCount, createGame } from "@/lib/engine/game";
import { currentPlayerId, getLegalFlipTargets } from "@/lib/engine/turns";
import { AiDifficulty, CenterEffectId, GameAction, GameState } from "@/lib/engine/types";
import { computeRanks, placementBaseline, placementMaxDeviation } from "./cardStats";

/** Running totals for one bucket (a difficulty, or a starting position) across however many arena games have tallied a seat into it. */
export interface ArenaBucketStats {
  gamesPlayed: number;
  /** Rank-1 finishes -- ties for 1st (see computeRanks) count as a win for every tied seat, same "shared win" convention computeGameResult uses for the real game's own result. */
  wins: number;
  /** Sum of ((rank - placementBaseline) / placementMaxDeviation), the same fixed [-1, 1] scale cardStats.ts's own placementDeltaSum uses -- see its doc comment for why the normalization (not just the baseline subtraction) matters. */
  placementDeltaSum: number;
  /**
   * Sum of every hard/expert-strategy decision's sample count this bucket has seen --
   * 0 for easy/medium (no search loop to sample). Populated by both modes
   * (simulateArenaGame and simulateFixedSeatArenaGame/dispatchArenaSeatAction).
   */
  searchSamplesSum: number;
  /** Sum of the corresponding decisions' actual candidate counts (not just maxCandidates -- a late-game decision can have fewer legal candidates than configured) -- the denominator for avgSamplesPerCandidate. */
  searchCandidatesSum: number;
  /**
   * How many of this bucket's turn decisions had at least one legal flip target --
   * i.e. flipping was actually possible, not blocked by flip-lock or "nothing
   * face-down left". The denominator for avgEligibleFlipRate -- deliberately not
   * "flips / all decisions", since most decisions (before flip unlocks, or once
   * nothing's left to flip) can never produce a flip regardless of how eager or
   * reluctant a seat is.
   */
  flipEligibleDecisions: number;
  /** How many of those flip-eligible decisions actually resulted in a flip. */
  flipsChosen: number;
  /** How many round-boundary votes this bucket's seat(s) cast, decided via each seat's own real difficulty/strategy logic (computeVoteForDifficulty for shuffle mode, an equivalent strategy dispatch for fixed-per-seat mode) -- not the plain computeAiVote applyAction defaults to when no override is given. The denominator for avgVoteEndRate. */
  votesCast: number;
  /** How many of those votes were "yes, end the game now". */
  votesYes: number;
  /** Sum of the ending round number (GameState.round at "ended") of every game this bucket's seat(s) played -- same per-game weighting cardStats.ts's own overall.roundLengthSum uses. A game-wide number, not a per-seat one: every seat in the same game contributes the same value, since round length isn't a property of any one seat's play. */
  roundLengthSum: number;
}

export function emptyArenaBucket(): ArenaBucketStats {
  return { gamesPlayed: 0, wins: 0, placementDeltaSum: 0, searchSamplesSum: 0, searchCandidatesSum: 0, flipEligibleDecisions: 0, flipsChosen: 0, votesCast: 0, votesYes: 0, roundLengthSum: 0 };
}

/**
 * Fills in any field missing from a possibly-stale persisted bucket (e.g. one saved
 * before votesCast/votesYes -- or any future field -- existed) with emptyArenaBucket's
 * zero, instead of leaving it `undefined` -- see arenaStore.ts's loadArenaState, whose
 * shallow merge takes a persisted `stats`/`seatBuckets` blob wholesale and would
 * otherwise silently carry `undefined` fields through into `undefined / undefined`
 * (NaN) arithmetic in summarizeBucket, rather than the intended "no data yet" null.
 */
export function normalizeArenaBucket(bucket: Partial<ArenaBucketStats> | null | undefined): ArenaBucketStats {
  return { ...emptyArenaBucket(), ...bucket };
}

/**
 * Two independent marginal breakdowns of the same batch of arena games -- not a full
 * difficulty×position cross-tab, which would need a lot more games per cell to be
 * readable. `byPosition` is keyed by 1-indexed turn-order position (1 = goes first),
 * never a raw seat/array index, which is meaningless once each game's firstPlayerIndex
 * is randomized (see simulateArenaGame).
 */
export interface ArenaStats {
  byDifficulty: Record<AiDifficulty, ArenaBucketStats>;
  byPosition: Record<number, ArenaBucketStats>;
}

export function createEmptyArenaStats(): ArenaStats {
  return {
    byDifficulty: { easy: emptyArenaBucket(), medium: emptyArenaBucket(), hard: emptyArenaBucket(), expert: emptyArenaBucket() },
    byPosition: {},
  };
}

/** Derived per-bucket averages for display -- null (not 0) win rate/delta for a bucket with no games yet, so a UI can render "—" instead of a misleading 0, same convention cardStats.ts's own statsSummary uses. */
export interface ArenaBucketRow {
  label: string;
  gamesPlayed: number;
  winRate: number | null;
  avgPlacementDelta: number | null;
  /** Average samples evaluated per candidate across every hard/expert decision this bucket saw -- null for easy/medium or an untallied bucket (see ArenaBucketStats.searchCandidatesSum). */
  avgSamplesPerCandidate: number | null;
  /** Fraction of flip-eligible decisions (see ArenaBucketStats.flipEligibleDecisions) that actually resulted in a flip -- null if this bucket never saw a decision where flipping was even legal. Deliberately not "flips / all decisions": most decisions can't flip at all regardless of strategy, so that version would mostly just measure how much of the game happened before/after flip was ever possible, not how flip-happy a seat actually is. */
  avgEligibleFlipRate: number | null;
  /** Fraction of this bucket's round-boundary votes that were "yes" -- null if this bucket never cast one (e.g. a game that always ended some other way before a vote was ever needed). */
  avgVoteEndRate: number | null;
  /** Average ending round number of every game this bucket's seat(s) played -- null for an untallied bucket. */
  avgRoundLength: number | null;
}

function summarizeBucket(label: string, bucket: ArenaBucketStats): ArenaBucketRow {
  return {
    label,
    gamesPlayed: bucket.gamesPlayed,
    winRate: bucket.gamesPlayed === 0 ? null : bucket.wins / bucket.gamesPlayed,
    avgPlacementDelta: bucket.gamesPlayed === 0 ? null : bucket.placementDeltaSum / bucket.gamesPlayed,
    avgSamplesPerCandidate: bucket.searchCandidatesSum === 0 ? null : bucket.searchSamplesSum / bucket.searchCandidatesSum,
    avgEligibleFlipRate: bucket.flipEligibleDecisions === 0 ? null : bucket.flipsChosen / bucket.flipEligibleDecisions,
    avgRoundLength: bucket.gamesPlayed === 0 ? null : bucket.roundLengthSum / bucket.gamesPlayed,
    avgVoteEndRate: bucket.votesCast === 0 ? null : bucket.votesYes / bucket.votesCast,
  };
}

const DIFFICULTY_LABELS: Record<AiDifficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert" };

/** Only buckets that actually have games -- a difficulty the caller never selected, or a position that never came up (shouldn't happen once every seat's been filled, but stays defensive), doesn't clutter the table with an all-"—" row. */
export function summarizeArenaStats(stats: ArenaStats): { byDifficulty: ArenaBucketRow[]; byPosition: ArenaBucketRow[] } {
  const byDifficulty = (Object.keys(stats.byDifficulty) as AiDifficulty[])
    .filter((d) => stats.byDifficulty[d].gamesPlayed > 0)
    .map((d) => summarizeBucket(DIFFICULTY_LABELS[d], stats.byDifficulty[d]));
  const byPosition = Object.keys(stats.byPosition)
    .map(Number)
    .sort((a, b) => a - b)
    .map((p) => summarizeBucket(`${p}${ordinalSuffix(p)}`, stats.byPosition[p]));
  return { byDifficulty, byPosition };
}

function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * Randomly assigns one of `difficulties` to each of `playerCount` seats -- cycles
 * through the list first so there's always exactly one assignment per seat even when
 * there are more seats than difficulties (e.g. 3 difficulties selected in an 8p game),
 * then Fisher-Yates shuffles the result. The shuffle is what matters: without it,
 * "difficulty A always seats first" would be indistinguishable from a genuine
 * difficulty effect, since seat/turn-order position also affects outcome (that's the
 * whole reason byPosition exists).
 */
export function assignSeatDifficulties(playerCount: number, difficulties: AiDifficulty[], rng: () => number): AiDifficulty[] {
  const seats = Array.from({ length: playerCount }, (_, i) => difficulties[i % difficulties.length]);
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }
  return seats;
}

/**
 * Plays one full AI-only game with an independent, randomly-shuffled difficulty per
 * seat (unlike every other entrypoint, which uses one GameConfig.aiDifficulty for the
 * whole game) and tallies each seat's outcome into `stats`, mutated in place -- same
 * "working copy accumulated across a whole run" pattern cardStats.ts's tallyGame uses.
 * `config.aiDifficulty` from configForPlayerCount is left at its default and never
 * read for turn decisions here; each seat's real difficulty comes from the per-player
 * map built below instead. `hardOptions` overrides "hard" seats' search budget for
 * this game only (defaults to the real DEFAULT_TWO_PLY_OPTIONS) -- see the Arena
 * page's own "Hard search budget" control for why a batch might want a smaller one:
 * hard's default 250ms/decision is calibrated for a real single game's pacing, not
 * for running hundreds of games back to back.
 */
export function simulateArenaGame(
  playerCount: number,
  centerEffect: CenterEffectId,
  difficulties: AiDifficulty[],
  stats: ArenaStats,
  rng: () => number,
  hardOptions?: TwoPlyOptions
): void {
  const playerIds = Array.from({ length: playerCount }, (_, i) => `arena${i}`);
  const seatDifficulties = assignSeatDifficulties(playerCount, difficulties, rng);
  const difficultyByPlayerId = new Map(playerIds.map((id, i) => [id, seatDifficulties[i]]));
  const config = configForPlayerCount(playerCount, centerEffect);
  const firstPlayerIndex = Math.floor(rng() * playerIds.length);
  let state = createGame(playerIds, config, rng, playerIds, firstPlayerIndex);

  // Both bucket lookups below (difficulty + position) need a seat's index and its
  // assigned difficulty repeatedly -- turn decisions, votes, and the final tally all
  // resolve the same pair of buckets for the same playerId, so this is shared instead
  // of re-deriving position's arithmetic three separate times.
  const bucketsFor = (playerId: string): ArenaBucketStats[] => {
    const seatIndex = playerIds.indexOf(playerId);
    const position = ((seatIndex - firstPlayerIndex + playerCount) % playerCount) + 1;
    if (!stats.byPosition[position]) stats.byPosition[position] = emptyArenaBucket();
    return [stats.byDifficulty[difficultyByPlayerId.get(playerId)!], stats.byPosition[position]];
  };

  const computeVote: ComputeVoteFn = (voteState, playerId, voteRng) => {
    const difficulty = difficultyByPlayerId.get(playerId)!;
    const vote = hardOptions
      ? computeVoteForDifficulty(voteState, playerId, difficulty, voteRng, hardOptions)
      : computeVoteForDifficulty(voteState, playerId, difficulty, voteRng);
    for (const bucket of bucketsFor(playerId)) {
      bucket.votesCast++;
      if (vote) bucket.votesYes++;
    }
    return vote;
  };

  while (state.phase === "playing") {
    const activeId = currentPlayerId(state);
    const difficulty = difficultyByPlayerId.get(activeId)!;
    const flipEligible = getLegalFlipTargets(state).length > 0;
    const twoPlySamplesBefore = twoPlySearchStats.samples;
    const twoPlyCandidatesBefore = twoPlySearchStats.candidatesEvaluated;
    const hardFastSamplesBefore = benchmarkTimings.samples;
    const hardFastCandidatesBefore = benchmarkTimings.candidatesEvaluated;
    const action = hardOptions
      ? chooseAiActionForDifficulty(state, activeId, difficulty, rng, hardOptions)
      : chooseAiActionForDifficulty(state, activeId, difficulty, rng);
    const samplesDelta = (twoPlySearchStats.samples - twoPlySamplesBefore) + (benchmarkTimings.samples - hardFastSamplesBefore);
    const candidatesDelta = (twoPlySearchStats.candidatesEvaluated - twoPlyCandidatesBefore) + (benchmarkTimings.candidatesEvaluated - hardFastCandidatesBefore);
    for (const bucket of bucketsFor(activeId)) {
      bucket.searchSamplesSum += samplesDelta;
      bucket.searchCandidatesSum += candidatesDelta;
      if (flipEligible) {
        bucket.flipEligibleDecisions++;
        if (action.type === "flip") bucket.flipsChosen++;
      }
    }
    state = applyAction(state, action, rng, computeVote);
  }

  const ranks = computeRanks(state.result!.scores);
  const baseline = placementBaseline(playerCount);
  const maxDeviation = placementMaxDeviation(playerCount);

  playerIds.forEach((id) => {
    const rank = ranks.get(id)!;
    const delta = (rank - baseline) / maxDeviation;
    const won = rank === 1;

    for (const bucket of bucketsFor(id)) {
      bucket.gamesPlayed++;
      bucket.placementDeltaSum += delta;
      if (won) bucket.wins++;
      bucket.roundLengthSum += state.round;
    }
  });
}

/**
 * A second, independent testing mode alongside simulateArenaGame above -- that one
 * exists to answer "does a difficulty LABEL win more," and deliberately shuffles which
 * seat gets which difficulty every game specifically so no single seat's results can
 * be trusted (see assignSeatDifficulties). This mode answers a different question:
 * "does THIS specific configuration (e.g. Hard-Fast at 150ms/6 candidates vs. real Hard
 * at 250ms/8) actually perform differently" -- so seat assignment here is the opposite,
 * fixed for the whole batch, not reshuffled. `firstPlayerIndex` is still randomized per
 * game (see simulateFixedSeatArenaGame below), same as the shuffled mode, so a fixed
 * seat's actual turn-order position still varies game to game -- that alone is enough
 * to keep position bias from being mistaken for a real strength difference, without
 * needing to also randomize which config sits in which seat.
 */
export type ArenaSeatStrategy = "easy" | "medium" | "hardTwoPly" | "hardFast";

export const ARENA_SEAT_STRATEGY_LABELS: Record<ArenaSeatStrategy, string> = {
  easy: "Easy",
  medium: "Medium",
  hardTwoPly: "Hard",
  hardFast: "Hard (Fast fork)",
};

/** One seat's fixed AI configuration for the whole batch. `timeBudgetMs`/`maxCandidates`/`roundsAhead` only apply to (and are only ever shown in the UI for) the two "hard" strategies -- easy/medium have no search budget to configure. */
export interface ArenaSeatConfig {
  strategy: ArenaSeatStrategy;
  timeBudgetMs: number;
  maxCandidates: number;
  roundsAhead: number;
}

/** A fresh seat, defaulted to Medium -- the same "no search budget to think about yet" starting point every difficulty picker in the app defaults new/unconfigured slots to. */
export function defaultArenaSeatConfig(): ArenaSeatConfig {
  return defaultArenaSeatConfigFor("medium");
}

/**
 * Same idea as defaultArenaSeatConfig, but the search-budget numbers actually match
 * whichever strategy is given -- used when a seat's strategy changes (see the arena
 * page's SeatConfigRow), so switching to "Hard (Fast fork)" resets to ITS OWN real
 * defaults (DEFAULT_HARD_FAST_OPTIONS: 70 candidates, 200ms) instead of silently
 * carrying over Hard's (DEFAULT_TWO_PLY_OPTIONS: 8 candidates, 250ms) or whatever
 * numbers happened to be left over from the previously-selected strategy. Easy/Medium
 * have no search budget to speak of, so they just get twoPly's numbers as an inert
 * placeholder -- never shown or read for those two.
 */
export function defaultArenaSeatConfigFor(strategy: ArenaSeatStrategy): ArenaSeatConfig {
  const defaults = strategy === "hardFast" ? DEFAULT_HARD_FAST_OPTIONS : DEFAULT_TWO_PLY_OPTIONS;
  return { strategy, timeBudgetMs: defaults.timeBudgetMs, maxCandidates: defaults.maxCandidates, roundsAhead: defaults.roundsAhead };
}

/** Short, human-readable summary of a seat's config -- easy/medium need nothing beyond their name; either hard strategy spells out exactly what it's running with, since that's the whole point of this mode (comparing configurations, not just labels). */
export function arenaSeatConfigLabel(config: ArenaSeatConfig): string {
  const name = ARENA_SEAT_STRATEGY_LABELS[config.strategy];
  if (config.strategy !== "hardTwoPly" && config.strategy !== "hardFast") return name;
  return `${name} (${config.timeBudgetMs}ms, ${config.maxCandidates} cand, ${config.roundsAhead} rd)`;
}

/** A dispatched action, plus how many samples/candidates that one decision contributed to the AI's search loop -- 0/0 for easy/medium (no search loop) and for flip/vote/pass decisions (rankedPlacementCandidates/evaluateCandidateOnce never run) -- and whether flipping was even legal for this decision, regardless of strategy. Deltas, not running totals -- read before/after the underlying strategy call from twoPly.ts's/hardFast.ts's own global counters, which is safe here since JS is single-threaded and every call is synchronous/sequential regardless of how seats/games interleave. */
interface DispatchedSeatAction {
  action: GameAction;
  samplesDelta: number;
  candidatesDelta: number;
  flipEligible: boolean;
}

/** The seat config form doesn't expose flip/vote-search knobs (flipMaxCandidates/flipTimeBudgetMs/voteTimeBudgetMs/...) yet -- those stay at DEFAULT_HARD_FAST_OPTIONS' own starting point regardless of what this seat's placement search is set to, until that's deliberately added as its own tunable. Shared by dispatchArenaSeatAction and computeVoteForSeat so both agree on the same options for a given seat. */
function hardFastOptionsForSeat(config: ArenaSeatConfig): HardFastOptions {
  const twoPlyOptions: TwoPlyOptions = {
    timeBudgetMs: config.timeBudgetMs,
    maxCandidates: config.maxCandidates,
    roundsAhead: config.roundsAhead,
  };
  return { ...DEFAULT_HARD_FAST_OPTIONS, ...twoPlyOptions };
}

/** Fixed-per-seat mode's equivalent of computeVoteForDifficulty -- only "hardFast" has a real, distinct vote decision (chooseExpertVote); every other strategy falls back to the plain computeAiVote, same as difficulty.ts's own dispatch does for easy/medium/hard. */
function computeVoteForSeat(state: GameState, playerId: string, config: ArenaSeatConfig, rng: () => number): boolean {
  if (config.strategy === "hardFast") return chooseExpertVote(state, playerId, hardFastOptionsForSeat(config), rng);
  return computeAiVote(state, playerId, rng);
}

function dispatchArenaSeatAction(state: GameState, playerId: string, config: ArenaSeatConfig, rng: () => number): DispatchedSeatAction {
  const flipEligible = getLegalFlipTargets(state).length > 0;
  const twoPlyOptions: TwoPlyOptions = {
    timeBudgetMs: config.timeBudgetMs,
    maxCandidates: config.maxCandidates,
    roundsAhead: config.roundsAhead,
  };
  const hardFastOptions = hardFastOptionsForSeat(config);
  switch (config.strategy) {
    case "easy":
      return { action: chooseRandomAiAction(state, playerId, rng), samplesDelta: 0, candidatesDelta: 0, flipEligible };
    case "medium":
      return { action: chooseGreedyAiAction(state, playerId, rng), samplesDelta: 0, candidatesDelta: 0, flipEligible };
    case "hardTwoPly": {
      const samplesBefore = twoPlySearchStats.samples;
      const candidatesBefore = twoPlySearchStats.candidatesEvaluated;
      const action = chooseTwoPlyAction(state, playerId, twoPlyOptions, rng);
      return { action, samplesDelta: twoPlySearchStats.samples - samplesBefore, candidatesDelta: twoPlySearchStats.candidatesEvaluated - candidatesBefore, flipEligible };
    }
    case "hardFast": {
      const samplesBefore = benchmarkTimings.samples;
      const candidatesBefore = benchmarkTimings.candidatesEvaluated;
      const action = chooseHardFastAction(state, playerId, hardFastOptions, rng);
      return { action, samplesDelta: benchmarkTimings.samples - samplesBefore, candidatesDelta: benchmarkTimings.candidatesEvaluated - candidatesBefore, flipEligible };
    }
  }
}

/**
 * Running totals for one fixed seat across a batch -- deliberately NOT bundled with
 * that seat's ArenaSeatConfig (an earlier version of this did, and it was a real bug:
 * the config living inside this array meant editing a seat in the UI updated the
 * page's own seatConfigs state but left this array's copy stale until the next full
 * rebuild, so a batch could silently keep simulating -- and displaying -- the OLD
 * config after an edit). `seatConfigs` (React state, owned by the page) is the single
 * source of truth for what each seat runs with; this array is just the running bucket
 * totals, always zipped together with the CURRENT seatConfigs at simulate/summarize
 * time (see simulateFixedSeatArenaGame/summarizeFixedSeatArenaStats below), never
 * stored redundantly.
 */
export type ArenaSeatBuckets = ArenaBucketStats[];

export function createEmptyFixedSeatArenaStats(playerCount: number): ArenaSeatBuckets {
  return Array.from({ length: playerCount }, () => emptyArenaBucket());
}

export interface ArenaSeatBucketRow extends ArenaBucketRow {
  seatIndex: number;
  config: ArenaSeatConfig;
}

/** Same derivation as summarizeBucket/summarizeArenaStats above, just one row per fixed seat instead of per difficulty/position. Takes the current seatConfigs fresh, not a snapshot, so an edited-but-not-yet-simulated seat's config always shows accurately even before the next Run. */
export function summarizeFixedSeatArenaStats(seatConfigs: ArenaSeatConfig[], buckets: ArenaSeatBuckets): ArenaSeatBucketRow[] {
  return buckets.map((bucket, seatIndex) => ({
    ...summarizeBucket(`Seat ${seatIndex + 1}`, bucket),
    seatIndex,
    config: seatConfigs[seatIndex],
  }));
}

/**
 * Plays one full AI-only game with each seat's strategy/options fixed for the whole
 * batch (see this section's own doc comment for how this differs from
 * simulateArenaGame above) and tallies each seat's outcome into `buckets`, mutated in
 * place. `seatConfigs` and `buckets` must be the same length (the player count for
 * this game) and correspond seat-for-seat -- the caller owns keeping both in sync with
 * whatever playerCount it's running (see createEmptyFixedSeatArenaStats).
 */
export function simulateFixedSeatArenaGame(centerEffect: CenterEffectId, seatConfigs: ArenaSeatConfig[], buckets: ArenaSeatBuckets, rng: () => number): void {
  const playerCount = seatConfigs.length;
  const playerIds = Array.from({ length: playerCount }, (_, i) => `arena${i}`);
  const config = configForPlayerCount(playerCount, centerEffect);
  const firstPlayerIndex = Math.floor(rng() * playerIds.length);
  let state = createGame(playerIds, config, rng, playerIds, firstPlayerIndex);

  const computeVote: ComputeVoteFn = (voteState, playerId, voteRng) => {
    const seatIndex = playerIds.indexOf(playerId);
    const vote = computeVoteForSeat(voteState, playerId, seatConfigs[seatIndex], voteRng);
    buckets[seatIndex].votesCast++;
    if (vote) buckets[seatIndex].votesYes++;
    return vote;
  };

  while (state.phase === "playing") {
    const activeId = currentPlayerId(state);
    const seatIndex = playerIds.indexOf(activeId);
    const { action, samplesDelta, candidatesDelta, flipEligible } = dispatchArenaSeatAction(state, activeId, seatConfigs[seatIndex], rng);
    buckets[seatIndex].searchSamplesSum += samplesDelta;
    buckets[seatIndex].searchCandidatesSum += candidatesDelta;
    if (flipEligible) {
      buckets[seatIndex].flipEligibleDecisions++;
      if (action.type === "flip") buckets[seatIndex].flipsChosen++;
    }
    state = applyAction(state, action, rng, computeVote);
  }

  const ranks = computeRanks(state.result!.scores);
  const baseline = placementBaseline(playerCount);
  const maxDeviation = placementMaxDeviation(playerCount);

  playerIds.forEach((id, seatIndex) => {
    const rank = ranks.get(id)!;
    const delta = (rank - baseline) / maxDeviation;
    const won = rank === 1;
    const bucket = buckets[seatIndex];
    bucket.gamesPlayed++;
    bucket.placementDeltaSum += delta;
    if (won) bucket.wins++;
    bucket.roundLengthSum += state.round;
  });
}
