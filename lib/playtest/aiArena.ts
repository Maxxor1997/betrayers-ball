import { chooseAiActionForDifficulty } from "@/lib/ai/difficulty";
import { MctsOptions } from "@/lib/ai/mcts";
import { applyAction, configForPlayerCount, createGame } from "@/lib/engine/game";
import { currentPlayerId } from "@/lib/engine/turns";
import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";
import { computeRanks, placementBaseline, placementMaxDeviation } from "./cardStats";

/** Running totals for one bucket (a difficulty, or a starting position) across however many arena games have tallied a seat into it. */
export interface ArenaBucketStats {
  gamesPlayed: number;
  /** Rank-1 finishes -- ties for 1st (see computeRanks) count as a win for every tied seat, same "shared win" convention computeGameResult uses for the real game's own result. */
  wins: number;
  /** Sum of ((rank - placementBaseline) / placementMaxDeviation), the same fixed [-1, 1] scale cardStats.ts's own placementDeltaSum uses -- see its doc comment for why the normalization (not just the baseline subtraction) matters. */
  placementDeltaSum: number;
}

function emptyArenaBucket(): ArenaBucketStats {
  return { gamesPlayed: 0, wins: 0, placementDeltaSum: 0 };
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
    byDifficulty: { easy: emptyArenaBucket(), medium: emptyArenaBucket(), hard: emptyArenaBucket() },
    byPosition: {},
  };
}

/** Derived per-bucket averages for display -- null (not 0) win rate/delta for a bucket with no games yet, so a UI can render "—" instead of a misleading 0, same convention cardStats.ts's own statsSummary uses. */
export interface ArenaBucketRow {
  label: string;
  gamesPlayed: number;
  winRate: number | null;
  avgPlacementDelta: number | null;
}

function summarizeBucket(label: string, bucket: ArenaBucketStats): ArenaBucketRow {
  return {
    label,
    gamesPlayed: bucket.gamesPlayed,
    winRate: bucket.gamesPlayed === 0 ? null : bucket.wins / bucket.gamesPlayed,
    avgPlacementDelta: bucket.gamesPlayed === 0 ? null : bucket.placementDeltaSum / bucket.gamesPlayed,
  };
}

const DIFFICULTY_LABELS: Record<AiDifficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

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
 * map built below instead. `hardMctsOptions` overrides "hard" seats' search budget
 * for this game only (defaults to the real DEFAULT_MCTS_OPTIONS) -- see the Arena
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
  hardMctsOptions?: MctsOptions
): void {
  const playerIds = Array.from({ length: playerCount }, (_, i) => `arena${i}`);
  const seatDifficulties = assignSeatDifficulties(playerCount, difficulties, rng);
  const difficultyByPlayerId = new Map(playerIds.map((id, i) => [id, seatDifficulties[i]]));
  const config = configForPlayerCount(playerCount, centerEffect);
  const firstPlayerIndex = Math.floor(rng() * playerIds.length);
  let state = createGame(playerIds, config, rng, playerIds, firstPlayerIndex);

  while (state.phase === "playing") {
    const activeId = currentPlayerId(state);
    const action = hardMctsOptions
      ? chooseAiActionForDifficulty(state, activeId, difficultyByPlayerId.get(activeId)!, rng, hardMctsOptions)
      : chooseAiActionForDifficulty(state, activeId, difficultyByPlayerId.get(activeId)!, rng);
    state = applyAction(state, action, rng);
  }

  const ranks = computeRanks(state.result!.scores);
  const baseline = placementBaseline(playerCount);
  const maxDeviation = placementMaxDeviation(playerCount);

  playerIds.forEach((id, seatIndex) => {
    const rank = ranks.get(id)!;
    const delta = (rank - baseline) / maxDeviation;
    const won = rank === 1;
    const position = ((seatIndex - firstPlayerIndex + playerCount) % playerCount) + 1;

    const difficultyBucket = stats.byDifficulty[difficultyByPlayerId.get(id)!];
    if (!stats.byPosition[position]) stats.byPosition[position] = emptyArenaBucket();
    const positionBucket = stats.byPosition[position];

    for (const bucket of [difficultyBucket, positionBucket]) {
      bucket.gamesPlayed++;
      bucket.placementDeltaSum += delta;
      if (won) bucket.wins++;
    }
  });
}
