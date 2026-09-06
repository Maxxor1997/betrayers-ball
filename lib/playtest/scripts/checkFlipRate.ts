import { createEmptyArenaStats, simulateArenaGame, summarizeArenaStats } from "../aiArena";
import { CenterEffectId } from "../../engine/types";

/** One-off diagnostic (not part of the balance-report skill): tests whether 8p's
 * collapsed flip rate is structural (fewer legal flip targets, e.g. more Cyclops
 * copies blocking neighbors) or behavioral (expert AI declining to flip even when
 * legal) -- avgEligibleFlipRate isolates exactly that, unlike cardStats.ts's plain
 * outcome-based flipRate. */
const GAMES = Number(process.argv[3] ?? 100);

function run(playerCount: number) {
  const stats = createEmptyArenaStats();
  const start = Date.now();
  for (let i = 0; i < GAMES; i++) {
    simulateArenaGame(playerCount, "none" as CenterEffectId, ["expert"], stats, Math.random);
    if ((i + 1) % 20 === 0) process.stderr.write(`[${playerCount}p] ${i + 1}/${GAMES} (${((Date.now() - start) / 1000).toFixed(0)}s)\n`);
  }
  const { byDifficulty } = summarizeArenaStats(stats);
  const row = byDifficulty.find((r) => r.label === "Expert")!;
  console.log(
    `${playerCount}p: games=${row.gamesPlayed} eligibleFlipRate=${(row.avgEligibleFlipRate! * 100).toFixed(1)}% voteEndRate=${(row.avgVoteEndRate! * 100).toFixed(1)}%`
  );
}

run(Number(process.argv[2]));
