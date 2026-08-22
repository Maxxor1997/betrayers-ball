import { countAdjacentOccupied } from "../engine/board";
import { copiesForPlayerCount, CARD_DEFS } from "../content/cards";
import { shuffle } from "../engine/deck";
import { computeGameResult, estimateMargin } from "../engine/endgame";
import { applyAction } from "../engine/game";
import { applyPlace, currentPlayerId, getLegalFlipTargets, getLegalPlacementCells } from "../engine/turns";
import { CardId, GameAction, GameState, Position } from "../engine/types";
import { chooseGreedyAiAction, placementHeuristicAdjustment } from "./greedyAi";

/**
 * Exact fork of twoPly.ts (Hard difficulty's current, AI-Arena-validated
 * implementation -- see that file's own history/doc comments for how it got tuned),
 * frozen here as a starting point for a faster Hard AI. twoPly.ts itself is left
 * untouched/locked-in so it stays available as the known-good baseline to compare
 * against; this file is where speed experiments happen. Not wired into
 * chooseAiActionForDifficulty (or anywhere else) yet -- it's not a selectable
 * difficulty until that's deliberately done.
 */

export type Rng = () => number;

/**
 * Lightweight, always-on wall-clock accounting for where chooseHardFastAction's time
 * actually goes -- deliberately coarse (a handful of buckets, not per-line) so the
 * timer overhead itself stays negligible next to the real work being measured. Not
 * gated behind a flag: this file's whole purpose right now is speed experimentation,
 * so the accounting is meant to always be available, not opted into. See
 * scripts/benchmarkHardFast.ts for how this gets read/reset/visualized.
 */
export const benchmarkTimings = {
  /** rankedPlacementCandidates -- scoring every legal (card, cell) pair once via estimateMargin/placementHeuristicAdjustment to shortlist candidates. Paid once per decision, not once per sample. */
  rankCandidatesMs: 0,
  /** determinize -- guessing a full hidden-info-consistent world. Paid once per sample. */
  determinizeMs: 0,
  /** Applying the candidate's own placement action (+ any vote it triggers) to the freshly-determinized state, before the simulation loop starts. */
  applyCandidateMs: 0,
  /** The roundsAhead simulation loop's total -- sum of simulateChooseMs + simulateApplyMs below, kept as its own bucket too so the top-level breakdown (see benchmarkHardFast.ts) doesn't need to change. */
  simulateForwardMs: 0,
  /** Within the simulation loop: choosing a simulated turn's move -- fastRolloutAction for opponents' turns, the real (more expensive) chooseGreedyAiAction for the acting player's own turns, see evaluateCandidateOnce's doc comment. */
  simulateChooseMs: 0,
  /** Within the simulation loop: applying the chosen action + resolving any vote it triggers -- state-transition bookkeeping, not decision-making. */
  simulateApplyMs: 0,
  /** How many individual simulated turns ran inside simulateForward loops, across every sample -- for a per-turn average alongside samples/decisions. */
  simulatedTurns: 0,
  /** trueValues (computeGameResult) at the end of each sample -- resolving the final/snapshot board once. */
  scoreResultMs: 0,
  /** How many evaluateCandidateOnce samples were run -- for computing a per-sample average alongside the raw totals. */
  samples: 0,
  /** How many top-level chooseHardFastAction decisions were timed -- for computing a per-decision average. */
  decisions: 0,
};

export function resetBenchmarkTimings(): void {
  benchmarkTimings.rankCandidatesMs = 0;
  benchmarkTimings.determinizeMs = 0;
  benchmarkTimings.applyCandidateMs = 0;
  benchmarkTimings.simulateForwardMs = 0;
  benchmarkTimings.simulateChooseMs = 0;
  benchmarkTimings.simulateApplyMs = 0;
  benchmarkTimings.simulatedTurns = 0;
  benchmarkTimings.scoreResultMs = 0;
  benchmarkTimings.samples = 0;
  benchmarkTimings.decisions = 0;
}

/**
 * Builds a fully-known "guessed" GameState consistent with everything `viewerId`
 * could honestly know right now -- their own hand, their own board cards (any face
 * state -- a player always knows their own card, even face-down), and any face-up
 * board card (any owner, since flipping reveals it to everyone) all keep their true
 * identity. Everything else -- opponents' hidden hand cards, opponents' face-down
 * board cards, and the undrawn deck -- gets a fresh identity randomly assigned from
 * the pool of cards not already accounted for, preserving the real deck composition
 * (copiesForPlayerCount) exactly, just reshuffling *which* unknown card is which.
 *
 * Called fresh for every single sample (see evaluateCandidateOnce below), not once for
 * a whole decision -- a bad guess about hidden cards then only taints the one sample it
 * was used for, and averages out across however many other samples guessed
 * differently, rather than the whole decision resting on one possibly-wrong guess.
 */
function determinize(state: GameState, viewerId: string, rng: Rng): GameState {
  const viewer = state.players.find((p) => p.id === viewerId)!;
  const knownInstanceIds = new Set<string>();
  for (const c of viewer.hand) knownInstanceIds.add(c.instanceId);
  for (const c of state.board.values()) {
    if (c.faceUp || c.ownerId === viewerId) knownInstanceIds.add(c.instanceId);
  }

  const remainingCounts = new Map<CardId, number>();
  for (const cardId of Object.keys(CARD_DEFS) as CardId[]) {
    remainingCounts.set(cardId, copiesForPlayerCount(CARD_DEFS[cardId], state.config.playerCount));
  }
  const decrement = (cardId: CardId) => remainingCounts.set(cardId, remainingCounts.get(cardId)! - 1);
  for (const c of viewer.hand) decrement(c.cardId);
  for (const c of state.board.values()) {
    if (knownInstanceIds.has(c.instanceId)) decrement(c.cardId);
  }

  const pool: CardId[] = [];
  for (const [cardId, count] of remainingCounts) for (let i = 0; i < count; i++) pool.push(cardId);
  const shuffledPool = shuffle(pool, rng);
  let poolCursor = 0;
  const nextCardId = (): CardId => shuffledPool[poolCursor++];

  const players = state.players.map((p) =>
    p.id === viewerId ? p : { ...p, hand: p.hand.map((c) => (knownInstanceIds.has(c.instanceId) ? c : { ...c, cardId: nextCardId() })) }
  );

  const board = new Map(state.board);
  for (const [key, c] of state.board) {
    if (!knownInstanceIds.has(c.instanceId)) board.set(key, { ...c, cardId: nextCardId() });
  }

  const deck = state.deck.map((c) => ({ ...c, cardId: nextCardId() }));

  return { ...state, players, board, deck };
}

/**
 * A voting phase isn't a decision point this module plans around -- see game.ts, votes
 * are simultaneous/private and every AI seat's vote is filled automatically anyway.
 * Whenever simulation lands on "voting" (including for a real human seat, who isn't
 * present during a hypothetical simulation to actually answer), every still-pending
 * vote is simply cast "continue" (no) -- skipping the real per-player computeAiVote
 * decision (a full estimateMargin board-resolve per pending vote) entirely, since
 * profiling showed applying+resolving simulated turns, not choosing them, was the
 * dominant cost once the choose side got cheap (see fastRolloutAction). A simulated
 * rollout never needs to end the game early via a majority-yes vote to be useful --
 * roundsAhead is what bounds a sample, not a vote outcome -- so always voting "no" is
 * a fine, free simplification here specifically. This always terminates, since
 * applyAction's castVote path tallies and leaves "voting" the moment the last vote
 * comes in.
 */
function skipPendingVotes(state: GameState, rng: Rng): GameState {
  let s = state;
  while (s.phase === "voting") {
    const pending = s.players.find((p) => !(p.id in s.votes));
    if (!pending) break;
    s = applyAction(s, { type: "castVote", playerId: pending.id, vote: false }, rng);
  }
  return s;
}

/** Each player's total if the game were scored exactly as `state` currently stands -- a live snapshot (neighbor-dependent effects can still shift as more of the board fills in), used once a simulated round finishes without the game actually ending. Reads every card's TRUE identity, which is fine here -- everything in a determinized state is "true" by construction for that one sample. */
function trueValues(state: GameState): Record<string, number> {
  if (state.phase === "ended") return state.result!.scores;
  const playerIds = state.players.map((p) => p.id);
  return computeGameResult(state.board, state.config.boardBounds, state.round, playerIds, state.config.centerEffect).scores;
}

export interface HardFastOptions {
  /** Wall-clock budget for the placement decision -- see chooseHardFastAction's doc comment for why placement is the only decision this touches. */
  timeBudgetMs: number;
  /** How many of the current hand's legal placements get evaluated at all -- see rankedPlacementCandidates. */
  maxCandidates: number;
  /**
   * How many full game rounds (see GameState.round -- every player having acted once,
   * including the acting player's own subsequent turns) get simulated forward past the
   * candidate placement before evaluating -- 1 means "everyone else responds once,
   * then evaluate", 3 means "let it play out three full rounds deep, including my own
   * next couple of turns (played by chooseGreedyAiAction, not held static), before
   * evaluating". Cost scales roughly linearly with this: each extra round is
   * (playerCount x up to 2 actions) more simulated steps per sample, which under a
   * fixed timeBudgetMs means fewer independent samples per candidate -- more accurate
   * per-sample evaluations, but noisier averages, unless maxCandidates comes down to
   * compensate. There's no "right" answer here without measuring -- see the AI Arena
   * page.
   */
  roundsAhead: number;
  /**
   * Optional hard cap on how many full round-robin passes over the candidates run,
   * independent of timeBudgetMs -- real play never needs this (Infinity), but
   * timeBudgetMs alone makes the number of samples evaluated (and therefore how many
   * times `rng` gets called) depend on real wall-clock timing, which varies run to run
   * even with an identical seed. Tests that need reproducible output set this to a
   * small fixed number instead. Not to be confused with roundsAhead (a game-rounds
   * depth per sample) -- this is "how many times has every candidate been sampled".
   */
  maxPasses?: number;
}

/**
 * AI-Arena-validated via the fixed-per-seat mode: at this exact budget, two Fast-fork
 * seats beat two real-Hard seats (twoPly's own DEFAULT_TWO_PLY_OPTIONS, 250ms/8cand/
 * 1rd) head-to-head in the same 4-player games -- 35%/34% win rate vs 23%/30% (n=500
 * each seat, two separate batches showing the same gap). Widening maxCandidates from
 * 8 to 16 (same 250ms budget) was the deciding factor -- see rankedPlacementCandidates
 * and evaluateCandidateOnce's own doc comments for why the cheaper rollout here
 * affords roughly an order of magnitude more samples per decision than twoPly at the
 * same wall-clock budget, and why spending that on breadth (more candidates) rather
 * than depth (roundsAhead) is currently the better trade -- doubling roundsAhead cost
 * noticeably more than 2x per sample (measured ~3.24x), so widening candidates buys
 * more signal per unit of budget than deepening rounds does. This is the config
 * wired into chooseAiActionForDifficulty's "expert" difficulty (see difficulty.ts).
 */
export const DEFAULT_HARD_FAST_OPTIONS: HardFastOptions = {
  timeBudgetMs: 250,
  maxCandidates: 16,
  roundsAhead: 1,
};

/** Same ranking Medium's own choosePlacement uses (estimateMargin + placementHeuristicAdjustment), kept to placements only -- see chooseHardFastAction for why flip/pass aren't touched here. Pruning to the top few keeps the round-robin evaluation loop below cheap enough to run several passes within budget. */
function rankedPlacementCandidates(state: GameState, playerId: string, maxCandidates: number): { instanceId: string; position: Position }[] {
  const start = performance.now();
  const player = state.players.find((p) => p.id === playerId)!;
  const legalCells = getLegalPlacementCells(state);
  const candidates: { instanceId: string; position: Position }[] = [];
  for (const card of player.hand) {
    for (const position of legalCells) candidates.push({ instanceId: card.instanceId, position });
  }

  const scored = candidates.map((candidate) => {
    const postState = applyPlace(state, { type: "place", playerId, ...candidate });
    const score = estimateMargin(postState, playerId) + placementHeuristicAdjustment(state, playerId, candidate, postState);
    return { candidate, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const result = scored.slice(0, maxCandidates).map((s) => s.candidate);
  benchmarkTimings.rankCandidatesMs += performance.now() - start;
  return result;
}

/**
 * Cheap stand-in for "what does a plausible player do next", used only for the
 * roundsAhead forward-simulation loop inside evaluateCandidateOnce below -- NOT
 * chooseHardFastAction's own decision (that still ranks the real candidates via
 * Medium's full estimateMargin + placementHeuristicAdjustment scoring, see
 * rankedPlacementCandidates). Profiling found chooseGreedyAiAction's full one-ply scan
 * (every hand card x every legal cell, each scored by resolving the whole board
 * through estimateMargin) was the dominant cost of a sample once roundsAhead > 0 --
 * it was being paid on EVERY simulated turn, of EVERY sample, of EVERY candidate. A
 * rollout turn only needs to be plausible, not optimal, so this skips flipping
 * entirely (legal: a turn's flip is always optional, see hasFlippedThisTurn in
 * turns.ts) and skips the board-resolve-per-candidate scan too -- it places the
 * uniformly random card from hand into whichever legal cell has the most already-
 * occupied neighbors (ownerless tiles count, same as countAdjacentOccupied's own
 * definition), a free/no-resolve proxy for "a decent player clusters for adjacency"
 * rather than a genuine effect-aware evaluation. The card itself is picked randomly,
 * not by highest base value -- the hand's identities are already just determinize's
 * guess, not the real hand, so pretending to strategically pick "the best" of a fake
 * hand doesn't represent anything real; a random pick is simpler and no less honest.
 * Never calls estimateMargin, applyPlace, or placementHeuristicAdjustment at all.
 *
 * Flips get the same treatment: instead of chooseFlip's real evaluation (a baseline
 * estimateMargin plus a hypotheticalFlipMargin per own-card candidate, plus several
 * card-specific bonus scans), a rollout turn just flips a uniformly random legal
 * target with FAST_ROLLOUT_FLIP_RATE probability, own or opponent's, no scoring at
 * all. A flip doesn't end the turn (see hasFlippedThisTurn in turns.ts), so choosing
 * to flip here still leaves this same player's placement/pass to follow on the
 * loop's next iteration -- getLegalFlipTargets naturally returns [] by then, so this
 * function falls through to a normal placement without any extra bookkeeping.
 */
const FAST_ROLLOUT_FLIP_RATE = 0.5;

function fastRolloutAction(state: GameState, playerId: string, rng: Rng): GameAction {
  const flipTargets = getLegalFlipTargets(state);
  if (flipTargets.length > 0 && rng() < FAST_ROLLOUT_FLIP_RATE) {
    const target = flipTargets[Math.floor(rng() * flipTargets.length)];
    return { type: "flip", playerId, instanceId: target.instanceId };
  }

  const player = state.players.find((p) => p.id === playerId)!;
  const legalCells = getLegalPlacementCells(state);
  if (player.hand.length === 0 || legalCells.length === 0) {
    return { type: "pass", playerId };
  }

  const card = player.hand[Math.floor(rng() * player.hand.length)];

  let bestCells: Position[] = [];
  let bestCount = -1;
  for (const pos of legalCells) {
    const count = countAdjacentOccupied(state.board, state.config.boardBounds, pos);
    if (count > bestCount) {
      bestCount = count;
      bestCells = [pos];
    } else if (count === bestCount) {
      bestCells.push(pos);
    }
  }
  const position = bestCells[Math.floor(rng() * bestCells.length)];

  return { type: "place", playerId, instanceId: card.instanceId, position };
}

/**
 * `roundsAhead` full extra rounds: this candidate placement, then every player's
 * next turn(s), evaluated against the real resulting totals of one freshly-
 * determinized hidden-info guess. Unlike Medium's own estimateMargin (which only
 * ever sees the position immediately after the acting player's own placement, with
 * every future move collapsed into "unknown"), this genuinely looks further ahead
 * and sees a concrete, played-out consequence. Uses GameState.round (not "count
 * turns until it's playerId's turn again") to detect a completed round -- correct
 * regardless of round-start seat rotation, voting, or a center effect like Reckoning
 * redrawing hands at round 4, since all of that is already reflected in `round` by
 * the time it ticks over.
 *
 * Opponents' turns use the cheap fastRolloutAction above (see its own doc comment
 * for why a plausible-not-optimal guess is good enough there); `playerId`'s own
 * subsequent turns within the lookahead use the real chooseGreedyAiAction instead --
 * the acting player's own future moves are the one part of this rollout we actually
 * get to control in real play (unlike opponents', which are always a guess anyway),
 * so it's worth the extra cost to model them accurately rather than as a random
 * placement.
 */
function evaluateCandidateOnce(state: GameState, playerId: string, candidate: { instanceId: string; position: Position }, roundsAhead: number, rng: Rng): number {
  let t = performance.now();
  const determinized = determinize(state, playerId, rng);
  benchmarkTimings.determinizeMs += performance.now() - t;

  t = performance.now();
  let s = skipPendingVotes(applyAction(determinized, { type: "place", playerId, ...candidate }, rng), rng);
  benchmarkTimings.applyCandidateMs += performance.now() - t;

  const targetRound = s.round + roundsAhead;
  // Generous, player-count-aware safety cap -- not the real stopping condition
  // (targetRound is), just a guard against looping forever if something behaves
  // unexpectedly (e.g. a long pass-chain that never advances the round).
  const maxSteps = roundsAhead * state.players.length * 3;
  let steps = 0;
  const forwardStart = performance.now();
  while (s.phase === "playing" && s.round < targetRound && steps < maxSteps) {
    const activeId = currentPlayerId(s);
    let tt = performance.now();
    const action = activeId === playerId ? chooseGreedyAiAction(s, activeId, rng) : fastRolloutAction(s, activeId, rng);
    benchmarkTimings.simulateChooseMs += performance.now() - tt;

    tt = performance.now();
    s = skipPendingVotes(applyAction(s, action, rng), rng);
    benchmarkTimings.simulateApplyMs += performance.now() - tt;

    benchmarkTimings.simulatedTurns++;
    steps++;
  }
  benchmarkTimings.simulateForwardMs += performance.now() - forwardStart;

  t = performance.now();
  const values = trueValues(s);
  const myScore = values[playerId] ?? 0;
  const bestOpponent = Math.max(0, ...state.players.filter((p) => p.id !== playerId).map((p) => values[p.id] ?? 0));
  benchmarkTimings.scoreResultMs += performance.now() - t;
  benchmarkTimings.samples++;
  return myScore - bestOpponent;
}

/**
 * HardFast's decision function -- same (state, playerId, rng) -> GameAction call
 * convention as the other AI strategies. Starts out byte-for-byte identical in
 * behavior to twoPly.ts's chooseTwoPlyAction; this is the copy to actually modify when
 * experimenting with making Hard faster, so twoPly.ts's own validated behavior never
 * has to be disturbed to try something new.
 *
 * Candidates are pruned to `options.maxCandidates` (ranked by Medium's own scoring --
 * see rankedPlacementCandidates) and evaluated round-robin -- one pass through every
 * candidate before any candidate gets a second sample -- so a tight time budget still
 * covers every plausible option at least once instead of exhausting itself deep-diving
 * the single best-ranked one. Each sample determinizes its own fresh hidden-info guess
 * (see determinize's doc comment) so no single wrong guess about hidden cards can
 * dominate one candidate's average.
 */
export function chooseHardFastAction(
  state: GameState,
  playerId: string,
  options: HardFastOptions = DEFAULT_HARD_FAST_OPTIONS,
  rng: Rng = Math.random
): GameAction {
  benchmarkTimings.decisions++;
  const greedyChoice = chooseGreedyAiAction(state, playerId, rng);
  if (greedyChoice.type !== "place") return greedyChoice; // voting/flip/pass -- Medium's existing logic is untouched

  const candidates = rankedPlacementCandidates(state, playerId, options.maxCandidates);
  if (candidates.length <= 1) return greedyChoice; // nothing to compare

  const totals = candidates.map(() => ({ sum: 0, count: 0 }));
  const deadline = performance.now() + options.timeBudgetMs;
  const maxPasses = options.maxPasses ?? Infinity;
  let passes = 0;

  outer: while (performance.now() < deadline && passes < maxPasses) {
    for (let i = 0; i < candidates.length; i++) {
      if (performance.now() >= deadline) break outer;
      const value = evaluateCandidateOnce(state, playerId, candidates[i], options.roundsAhead, rng);
      totals[i].sum += value;
      totals[i].count++;
    }
    passes++;
  }

  let bestIdx = -1;
  let bestAvg = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    if (totals[i].count === 0) continue;
    const avg = totals[i].sum / totals[i].count;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestIdx = i;
    }
  }
  // bestIdx === -1 only if the very first evaluation didn't even finish before the
  // deadline -- an extremely tight budget edge case -- fall back to Medium's own pick.
  const chosen = bestIdx === -1 ? { instanceId: greedyChoice.instanceId, position: greedyChoice.position } : candidates[bestIdx];

  return { type: "place", playerId, instanceId: chosen.instanceId, position: chosen.position };
}
