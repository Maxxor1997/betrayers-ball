import { writeFileSync } from "node:fs";
import { chooseAiActionForDifficulty, computeVoteForDifficulty } from "../../ai/difficulty";
import { randomCenterEffectPool } from "../../content/centerEffects";
import { applyAction, ComputeVoteFn, configForPlayerCount, createGame } from "../../engine/game";
import { resolveBoard } from "../../engine/resolution";
import { currentPlayerId } from "../../engine/turns";
import { AiDifficulty, CenterEffectId, GameState } from "../../engine/types";
import { createEmptyStats, overallAvgFlipRate, overallAvgRoundLength, PlaytestStats, statsSummary, tallyGame } from "../cardStats";

/**
 * Headless CLI runner for the balance-report skill -- plays full AI-vs-AI games
 * outside the browser (no React, no Socket.IO server), using the same engine/AI call
 * sequence a real game uses, at whatever player count/difficulty/game count is asked
 * for. Written because no headless entrypoint existed before this -- both the
 * interactive playtest page and the AI Arena page only ever ran their simulation
 * loops inside a browser tab.
 *
 * Deliberately diverges from cardStats.ts's own simulateOneGame/simulateOneGameSteps
 * in one way: this threads computeVoteForDifficulty into applyAction's real
 * `computeVote` parameter, so a round-boundary vote at "expert" gets chooseExpertVote's
 * actual search-based decision. simulateOneGame never does this (it lets applyAction
 * fall back to its default, the plain heuristic computeAiVote, for every difficulty,
 * including expert) -- fine for the interactive playtest page's own purposes, but not
 * for a report meant to represent genuine full-strength expert play, which is what
 * this script exists for.
 *
 * Usage:
 *   npx tsx lib/playtest/scripts/runBalanceBatch.ts --players=4 --games=200 --difficulty=expert --out=/tmp/4p.json [--seed=1]
 */

interface Args {
  players: number;
  games: number;
  difficulty: AiDifficulty;
  out: string;
  seed?: number;
}

function parseArgs(): Args {
  const raw: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([\w-]+)=(.*)$/.exec(arg);
    if (match) raw[match[1]] = match[2];
  }
  const players = Number(raw.players);
  const games = Number(raw.games ?? 200);
  const difficulty = (raw.difficulty ?? "expert") as AiDifficulty;
  const out = raw.out;
  if (!players || !games || !out) {
    console.error("Usage: tsx runBalanceBatch.ts --players=N --games=N --difficulty=expert --out=path.json [--seed=N]");
    process.exit(1);
  }
  return { players, games, difficulty, out, seed: raw.seed !== undefined ? Number(raw.seed) : undefined };
}

/** Small, fast, seedable PRNG (mulberry32) so a run can be reproduced exactly by seed -- unlike Math.random, which every browser-based simulator in this repo uses unseeded. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateOneExpertGame(playerCount: number, centerEffect: CenterEffectId, aiDifficulty: AiDifficulty, rng: () => number): GameState {
  const playerIds = Array.from({ length: playerCount }, (_, i) => `sim${i}`);
  const config = configForPlayerCount(playerCount, centerEffect, aiDifficulty, rng);
  const firstPlayerIndex = Math.floor(rng() * playerIds.length);
  let state = createGame(playerIds, config, rng, playerIds, firstPlayerIndex);
  const computeVote: ComputeVoteFn = (voteState, playerId, voteRng) => computeVoteForDifficulty(voteState, playerId, aiDifficulty, voteRng);

  while (state.phase === "playing") {
    const activeId = currentPlayerId(state);
    const action = chooseAiActionForDifficulty(state, activeId, aiDifficulty, rng);
    state = applyAction(state, action, rng, computeVote);
  }
  return state;
}

/**
 * Builds and writes the same output shape at any point during the run, not just at
 * the end -- gamesCompleted lets a reader (or the balance-report skill) tell a
 * checkpoint apart from a finished run. Written because an unattended run has no
 * other way to survive being killed partway through (killed twice mid-run in
 * practice): without this, a kill at game 290/300 loses all 290 games' work, not
 * just the missing 10.
 */
function writeOutput(out: string, players: number, difficulty: AiDifficulty, games: number, seed: number | undefined, gamesCompleted: number, stats: PlaytestStats): void {
  const overall = {
    rows: statsSummary(stats),
    avgRoundLength: overallAvgRoundLength(stats),
    avgFlipRate: overallAvgFlipRate(stats),
  };
  const byLocation: Record<string, { games: number; rows: ReturnType<typeof statsSummary>; avgRoundLength: number | null; avgFlipRate: number | null }> = {};
  for (const id of Object.keys(stats.byCenterEffect) as CenterEffectId[]) {
    const bucket = stats.byCenterEffect[id];
    byLocation[id] = {
      games: bucket.overall.gamesTallied,
      rows: statsSummary(bucket),
      avgRoundLength: overallAvgRoundLength(bucket),
      avgFlipRate: overallAvgFlipRate(bucket),
    };
  }

  writeFileSync(out, JSON.stringify({ playerCount: players, difficulty, gameCount: games, gamesCompleted, seed: seed ?? null, overall, byLocation }, null, 2));
}

const CHECKPOINT_EVERY = 10;

function main(): void {
  const { players, games, difficulty, out, seed } = parseArgs();
  const rng = seed !== undefined ? mulberry32(seed) : Math.random;
  // "none"/World-Tree is a real, directly-runnable baseline location -- included here
  // because randomCenterEffectPool already includes it (it has no randPool:false
  // override), same rotation the interactive playtest page's own "random" mode uses.
  const locationPool = randomCenterEffectPool(players);

  const stats: PlaytestStats = createEmptyStats();
  const startedAt = Date.now();

  for (let i = 0; i < games; i++) {
    const centerEffect = locationPool[Math.floor(rng() * locationPool.length)];
    const finalState = simulateOneExpertGame(players, centerEffect, difficulty, rng);
    const result = resolveBoard(
      finalState.board,
      finalState.config.boardBounds,
      finalState.round,
      finalState.config.centerEffect,
      finalState.players.map((p) => p.id)
    );
    tallyGame(stats, result.cards, finalState.result!.scores, finalState.config.playerCount, finalState.round, finalState.config.centerEffect);

    if ((i + 1) % CHECKPOINT_EVERY === 0 || i + 1 === games) {
      const elapsedS = (Date.now() - startedAt) / 1000;
      const rate = (i + 1) / elapsedS;
      const etaS = (games - (i + 1)) / rate;
      process.stderr.write(`[${players}p ${difficulty}] ${i + 1}/${games} games (${elapsedS.toFixed(0)}s elapsed, ~${etaS.toFixed(0)}s remaining)\n`);
      writeOutput(out, players, difficulty, games, seed, i + 1, stats);
    }
  }

  process.stderr.write(`Done. Wrote ${out}\n`);
}

main();
