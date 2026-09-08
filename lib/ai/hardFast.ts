import { countAdjacentOccupied } from "../engine/board";
import { copiesForPlayerCount, CARD_DEFS } from "../content/cards";
import { shuffle } from "../engine/deck";
import { computeAiVote, computeGameResult, estimateMargin } from "../engine/endgame";
import { applyAction } from "../engine/game";
import { applyPlace, currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, offeredCardsFor } from "../engine/turns";
import { CardId, CardInstance, GameAction, GameState, Position } from "../engine/types";
import { chooseGreedyAiAction, flipCandidateScore, placementHeuristicAdjustment } from "./greedyAi";

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
  /** Sum of candidates.length across every decision that actually ran the round-robin loop (i.e. had more than one candidate to compare) -- the denominator for "samples per candidate", same purpose as twoPly.ts's own twoPlySearchStats.candidatesEvaluated. */
  candidatesEvaluated: 0,
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
  benchmarkTimings.candidatesEvaluated = 0;
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
  /**
   * How many flip targets get evaluated at all -- see rankedFlipCandidates. Split
   * evenly between own-owned and opponent-owned targets (half each, rounded down),
   * not "whichever pool scores higher" -- own and opponent scores aren't on the same
   * scale (see flipCandidateScore's own doc comment), and an unconditional own-first
   * fill previously meant opponent exploration could get crowded out of the
   * shortlist entirely whenever there were enough own-owned targets to fill every
   * slot. A fixed split guarantees both get a fair chance to be simulated, whenever
   * targets of that kind exist.
   */
  flipMaxCandidates: number;
  /**
   * Same idea as timeBudgetMs, but for the flip-candidate search -- deliberately
   * smaller. A flip sample is inherently a bit MORE expensive than a placement
   * sample too: a flip doesn't consume the turn, so the forward loop's very first
   * step is a real chooseGreedyAiAction call for the follow-up placement, unlike a
   * placement candidate's own turn (already used up before the loop starts, see
   * evaluateCandidateOnce's doc comment). Bumped from an original 50ms once adding
   * the "don't flip" baseline option (see chooseHardFastAction) made an already-tight
   * budget's starvation at high player counts measurably worse -- see
   * effectiveFlipSearchSize for the other half of that fix (scaling
   * flipMaxCandidates/flipRoundsAhead down instead of just raising this).
   */
  flipTimeBudgetMs: number;
  /** Same idea as maxPasses, but for the flip-candidate search. */
  flipMaxPasses?: number;
  /**
   * How many rounds forward the flip search simulates -- independent of roundsAhead
   * (placement's own lookahead), and deliberately deeper (2, vs placement's 1):
   * flipping is judged standalone against a same-metric "don't flip" baseline now
   * (see chooseHardFastAction's own doc comment for why the old flip-vs-placement
   * comparison was dropped in favor of this), not against a same-depth placement
   * baseline, so there's no reason its depth needs to match placement's.
   */
  flipRoundsAhead: number;
  /**
   * How much better than NOT flipping a candidate's average simulated margin must be
   * (strictly) to actually get taken -- an additive margin over the "don't flip"
   * baseline (see chooseHardFastAction), not a fixed absolute bar. It used to be
   * compared directly against a flip candidate's raw average
   * (myScore - bestOpponent), but that average's own scale isn't independent of
   * player count -- Math.max over more opponents (7 at 8p vs. 3 at 4p) skews higher
   * simply from being a max over more draws, so a fixed absolute bar cleared a real
   * flip rate at 4p (71.5% of legal opportunities, measured) but almost never at 8p
   * (22.3%) even though flipping wasn't actually worse there -- the yardstick had
   * just moved. Comparing against a same-metric baseline computed the same way
   * cancels that drift out, the same reasoning chooseExpertVote already uses for its
   * own end-now-vs-continue comparison. 0 is a first guess ("only flip if it looks
   * strictly better than not flipping"), not yet AI-Arena-validated.
   */
  flipThreshold: number;
  /**
   * How many game rounds forward chooseExpertVote simulates to decide whether
   * continuing looks better than ending now -- independent of roundsAhead (that one's
   * about a placement/flip decision's own lookahead), since "will the position keep
   * improving" is naturally a longer-horizon question than "what should I do this
   * turn".
   */
  voteRoundsAhead: number;
  /** Wall-clock budget for chooseExpertVote's repeated "if we continue" sampling -- there's only one scenario being sampled here (not multiple candidates to compare), so this budget converts directly into how many independent hidden-info guesses get averaged, tightening the estimate rather than differentiating options. */
  voteTimeBudgetMs: number;
  /** Same idea as maxPasses/flipMaxPasses, for chooseExpertVote's sampling loop. */
  voteMaxPasses?: number;
}

/**
 * AI-Arena-validated via the fixed-per-seat mode: at 250ms, two Fast-fork seats beat
 * two real-Hard seats (twoPly's own DEFAULT_TWO_PLY_OPTIONS, 250ms/8cand/1rd)
 * head-to-head in the same 4-player games -- 35%/34% win rate vs 23%/30% (n=500 each
 * seat, two separate batches showing the same gap). Widening maxCandidates from 8
 * (see rankedPlacementCandidates and evaluateCandidateOnce's own doc comments for why
 * the cheaper rollout here affords roughly an order of magnitude more samples per
 * decision than twoPly at the same wall-clock budget) was the deciding factor, and why
 * spending that on breadth (more candidates) rather than depth (roundsAhead) is
 * currently the better trade -- doubling roundsAhead cost noticeably more than 2x per
 * sample (measured ~3.24x), so widening candidates buys more signal per unit of budget
 * than deepening rounds does. A further sweep (16/24/32/40 candidates, n=500 each)
 * kept trending upward rather than plateauing, so maxCandidates was pushed to 70 --
 * still comfortably within the samples-per-candidate headroom measured at this budget
 * (see the real-budget check discussed in this file's own history). This is the
 * config wired into chooseAiActionForDifficulty's "expert" difficulty (see
 * difficulty.ts).
 *
 * flipMaxCandidates/flipTimeBudgetMs (4 candidates, 75ms -- bumped from an original
 * 50ms, see its own doc comment) and voteRoundsAhead/voteTimeBudgetMs (1 round, 50ms)
 * are trimmed down from an initial 100ms each -- flip search runs on essentially
 * every turn once flip unlocks (unlike vote, which only runs once per round), so its
 * cost stacks additively onto the existing 750ms AI_TURN_DELAY_MS pacing beat every
 * single turn for a real but rare payoff (flips get chosen occasionally, not often --
 * see hardFast.test.ts's own flip-search test). flipRoundsAhead (2, before
 * effectiveFlipSearchSize's own player-count scaling) and flipThreshold (0) are
 * similarly a first guess. None of the flip/vote numbers are independently
 * AI-Arena-validated yet the way the placement numbers above are -- tune from here
 * once measured.
 */
export const DEFAULT_HARD_FAST_OPTIONS: HardFastOptions = {
  timeBudgetMs: 200,
  maxCandidates: 70,
  roundsAhead: 1,
  voteRoundsAhead: 2,
  voteTimeBudgetMs: 50,
  flipMaxCandidates: 4,
  flipTimeBudgetMs: 75,
  flipRoundsAhead: 2,
  flipThreshold: 0,
};

/** Same ranking Medium's own choosePlacement uses (estimateMargin + placementHeuristicAdjustment), kept to placements only -- see chooseHardFastAction for why flip/pass aren't touched here. Pruning to the top few keeps the round-robin evaluation loop below cheap enough to run several passes within budget. */
function rankedPlacementCandidates(state: GameState, playerId: string, maxCandidates: number): { instanceId: string; position: Position }[] {
  const start = performance.now();
  const legalCells = getLegalPlacementCells(state);
  const candidates: { instanceId: string; position: Position }[] = [];
  for (const card of offeredCardsFor(state, playerId)) {
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
 * Shortlists which flip targets are worth a real simulated sample -- the top half of
 * own-owned targets (ranked by flipCandidateScore, a genuine margin delta for an own
 * target) and the top half of opponent-owned targets (ranked by their own priority
 * score), evaluated via real simulation instead of chooseFlip's own static
 * threshold/probability gating. A fixed even split, not "whichever pool scores
 * higher fills first": own and opponent scores aren't on the same scale (see
 * flipCandidateScore's own doc comment) so they're never merged into one ranking,
 * and an unconditional own-first fill would let a handful of mediocre own-owned
 * targets crowd every opponent-owned target out of the shortlist entirely, no matter
 * how promising those looked on their own terms. Whichever pool comes up short of
 * its half just contributes fewer candidates -- no backfilling from the other pool.
 */
function rankedFlipCandidates(state: GameState, playerId: string, maxFlipCandidates: number): CardInstance[] {
  const targets = getLegalFlipTargets(state);
  const byScoreDesc = (a: CardInstance, b: CardInstance) => flipCandidateScore(state, playerId, b) - flipCandidateScore(state, playerId, a);
  const own = targets.filter((t) => t.ownerId === playerId).sort(byScoreDesc);
  const opponent = targets.filter((t) => t.ownerId !== playerId).sort(byScoreDesc);
  const perPool = Math.floor(maxFlipCandidates / 2);
  return [...own.slice(0, perPool), ...opponent.slice(0, perPool)];
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

  const candidates = offeredCardsFor(state, playerId);
  const legalCells = getLegalPlacementCells(state);
  if (candidates.length === 0 || legalCells.length === 0) {
    return { type: "pass", playerId };
  }

  const card = candidates[Math.floor(rng() * candidates.length)];

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
 * `roundsAhead` full extra rounds: this candidate action (a placement, or -- see
 * chooseHardFastAction's flip-candidate search -- a flip, which doesn't consume the
 * turn, so the forward loop's own first step naturally becomes the follow-up
 * placement decision below), then every player's next turn(s), evaluated against the
 * real resulting totals of one freshly-determinized hidden-info guess. Unlike
 * Medium's own estimateMargin (which only ever sees the position immediately after
 * the acting player's own placement, with every future move collapsed into
 * "unknown"), this genuinely looks further ahead and sees a concrete, played-out
 * consequence. Uses GameState.round (not "count turns until it's playerId's turn
 * again") to detect a completed round -- correct regardless of round-start seat
 * rotation, voting, or a center effect like Reckoning redrawing hands at round 4,
 * since all of that is already reflected in `round` by the time it ticks over.
 *
 * Opponents' turns use the cheap fastRolloutAction above (see its own doc comment
 * for why a plausible-not-optimal guess is good enough there); `playerId`'s own
 * subsequent turns within the lookahead use the real chooseGreedyAiAction instead --
 * the acting player's own future moves are the one part of this rollout we actually
 * get to control in real play (unlike opponents', which are always a guess anyway),
 * so it's worth the extra cost to model them accurately rather than as a random
 * placement.
 *
 * `initialAction` is null for the vote-evaluation use case (see chooseExpertVote) --
 * there's no placement/flip to apply first, just this pending vote (and any others
 * still pending) resolving to "continue" (skipPendingVotes always votes "no"), then
 * the same forward simulation as any other candidate.
 *
 * Returns null (a "this sample doesn't count", not an error) if applying
 * `initialAction` fails against this one determinized guess -- the only known way
 * this happens is a flip candidate that's legal against the TRUE state
 * (rankedFlipCandidates/getLegalFlipTargets already filtered it there, which knows
 * every card's real identity even hidden ones) but happens to land next to a card
 * determinize randomly assigned "blocks adjacent flips" (e.g. Cyclops) in THIS
 * sample's fabricated world -- an artifact of the guess, not a real illegal move;
 * placement candidates (and the null/vote case) can't hit this, since this engine's
 * placement legality never depends on neighbor identity. Safe to just skip: the
 * candidate's average is still built from whichever samples didn't hit this, same as
 * any other sample-to-sample variance.
 */
function evaluateCandidateOnce(state: GameState, playerId: string, initialAction: GameAction | null, roundsAhead: number, rng: Rng): number | null {
  let t = performance.now();
  const determinized = determinize(state, playerId, rng);
  benchmarkTimings.determinizeMs += performance.now() - t;

  t = performance.now();
  let s: GameState;
  try {
    s = skipPendingVotes(initialAction ? applyAction(determinized, initialAction, rng) : determinized, rng);
  } catch {
    return null;
  }
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
 * Round-robin-evaluates `candidates` (one pass through every candidate before any
 * candidate gets a second sample, so a tight time budget still covers every plausible
 * option at least once instead of exhausting itself deep-diving the single best-
 * ranked one) and returns whichever averaged best, or null if the very first
 * evaluation didn't even finish before the deadline (an extremely tight budget edge
 * case) or `candidates` was empty to begin with. Shared by chooseHardFastAction's two
 * independent searches below (placement and flip) so their round-robin bookkeeping
 * can't silently drift apart from each other.
 *
 * `toAction` may return null for a candidate that means "do nothing this option" --
 * evaluateCandidateOnce already accepts a null initialAction (it's how vote's own
 * "end now" option scores the freshly-determinized board with no action applied
 * first). This is what lets the flip search below fold a "don't flip" baseline into
 * the SAME round-robin as the real flip candidates, sampled under identical
 * conditions, instead of a separate pass. `averages` exposes every candidate's own
 * average (null if it never got a sample) alongside the overall best -- placement's
 * call site ignores it (it only ever wants the single best), flip's needs it to find
 * the best REAL candidate and the baseline's own average separately, since "highest
 * average overall" doesn't distinguish "best flip" from "baseline won."
 */
function searchBest<T>(
  candidates: T[],
  toAction: (candidate: T) => GameAction | null,
  roundsAhead: number,
  timeBudgetMs: number,
  maxPasses: number,
  state: GameState,
  playerId: string,
  rng: Rng
): { action: GameAction | null; avg: number; averages: (number | null)[] } | null {
  if (candidates.length === 0) return null;
  benchmarkTimings.candidatesEvaluated += candidates.length;

  const totals = candidates.map(() => ({ sum: 0, count: 0 }));
  const deadline = performance.now() + timeBudgetMs;
  let passes = 0;

  outer: while (performance.now() < deadline && passes < maxPasses) {
    for (let i = 0; i < candidates.length; i++) {
      if (performance.now() >= deadline) break outer;
      const value = evaluateCandidateOnce(state, playerId, toAction(candidates[i]), roundsAhead, rng);
      if (value === null) continue; // this determinized guess made the action illegal -- doesn't count as a sample
      totals[i].sum += value;
      totals[i].count++;
    }
    passes++;
  }

  const averages = totals.map((t) => (t.count === 0 ? null : t.sum / t.count));
  let bestIdx = -1;
  let bestAvg = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const avg = averages[i];
    if (avg === null) continue;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;
  return { action: toAction(candidates[bestIdx]), avg: bestAvg, averages };
}

/**
 * HardFast's decision function -- same (state, playerId, rng) -> GameAction call
 * convention as the other AI strategies. Started out byte-for-byte identical in
 * behavior to twoPly.ts's chooseTwoPlyAction; this is the copy to actually modify when
 * experimenting with making Hard faster, so twoPly.ts's own validated behavior never
 * has to be disturbed to try something new.
 *
 * Flip is decided FIRST, standalone, against a same-metric "don't flip" baseline --
 * not by comparison against a placement search. An earlier version ran the full
 * placement search (options.maxCandidates/timeBudgetMs) unconditionally every
 * decision just to get a baseline to compare flip against, even though that result is
 * completely discarded whenever flip wins: flipping doesn't consume the turn, so the
 * very next call re-runs the placement search from scratch against the post-flip
 * board anyway. That made the (expensive) placement search pure wasted work on every
 * turn flip won, for no benefit -- its own result was never actually used. Now the
 * (cheap) flip search runs first, and the (expensive) placement search only runs at
 * all when flip isn't taken this turn, which is also the only time its result is ever
 * needed.
 *
 * The flip search folds a "don't flip" option into the SAME round-robin as the real
 * flip candidates (searchBest's `toAction` returning null for it), rather than
 * comparing a flip candidate's raw average against a fixed constant. A fixed constant
 * doesn't work here: evaluateCandidateOnce's score is myScore - max(every opponent's
 * score), and Math.max over more opponents (7 at 8p vs. 3 at 4p) is systematically
 * higher just from being a max over more draws -- nothing to do with whether flipping
 * is actually good. That drift alone was enough to collapse Expert's real flip rate
 * from 71.5% of legal opportunities at 4p to 22.3% at 8p (measured via AI Arena),
 * even though flipping wasn't genuinely worse at 8p -- the yardstick had just moved.
 * Comparing against a baseline sampled the exact same way (same metric, same
 * roundsAhead, same time budget) cancels that drift out, since the baseline drifts by
 * the same amount the real candidates do. Same reasoning chooseExpertVote below
 * already uses for its own end-now-vs-continue comparison.
 *
 * That fix alone made things WORSE at 8p (flip rate collapsed further, to ~0.1%) --
 * debug-logging searchBest's own per-candidate averages showed why: a sample's cost
 * is roughly roundsAhead * playerCount (each simulated round costs about one turn
 * per player), so at 8p, a single flipTimeBudgetMs (50ms) round-robin pass across
 * flipMaxCandidates (4) real candidates PLUS the new baseline was usually only
 * completing ONE sample of the FIRST candidate before the deadline hit -- everything
 * else, baseline included, stayed at zero samples on most decisions. Adding the
 * baseline pushed an already-tight budget over the edge; effectiveFlipSearchSize
 * below scales flipRoundsAhead/flipMaxCandidates down as player count grows (and
 * flipTimeBudgetMs was bumped up too, see DEFAULT_HARD_FAST_OPTIONS) so a full pass
 * costs roughly the same regardless of table size, restoring the round-robin's own
 * stated guarantee of covering every option at least once.
 *
 * A flip candidate's evaluateCandidateOnce call naturally ends up letting `playerId`
 * immediately choose their own follow-up placement via chooseGreedyAiAction (see that
 * function's own doc comment) -- a flip doesn't consume the turn, so the forward
 * loop's first step is still this same player's turn. Each sample determinizes its
 * own fresh hidden-info guess (see determinize's doc comment) so no single wrong
 * guess about hidden cards can dominate one candidate's average.
 */
/**
 * Scales flipMaxCandidates/flipRoundsAhead down as player count grows past 4, so a
 * full flip round-robin pass costs roughly the same regardless of table size instead
 * of quietly costing ~playerCount/4 times as much -- see chooseHardFastAction's own
 * doc comment for the measured 8p failure this fixes (the round-robin was barely
 * completing a single sample of a single candidate before its time budget ran out).
 * Both scale as roughly options.value * 4 / playerCount, floored at a safe minimum
 * (1 round, 2 candidates) so the search never degenerates to nothing -- clamped to
 * leave 2-4 player games completely untouched (their behavior was never broken, and
 * the reported problem was specifically measured at 8p). A first-guess proportional
 * curve derived from the cost model above, not an independently AI-Arena-validated
 * one -- same caveat as the rest of these flip/vote numbers.
 */
function effectiveFlipSearchSize(playerCount: number, options: HardFastOptions): { flipMaxCandidates: number; flipRoundsAhead: number } {
  if (playerCount <= 4) return { flipMaxCandidates: options.flipMaxCandidates, flipRoundsAhead: options.flipRoundsAhead };
  const scale = 4 / playerCount;
  return {
    flipMaxCandidates: Math.max(2, Math.round(options.flipMaxCandidates * scale)),
    flipRoundsAhead: Math.max(1, Math.round(options.flipRoundsAhead * scale)),
  };
}

/**
 * Per-player-above-4 discount applied to flipThreshold by effectiveFlipThreshold --
 * an explicit, acknowledged thumb on the scale (not a measured cost or fairness
 * argument like effectiveFlipSearchSize above) to close the remainder of the 4p/8p
 * eligible-flip-rate gap that effectiveFlipSearchSize's budget fix didn't reach
 * (measured: 4p 63.4%, 8p 34.2% after that fix -- see chooseHardFastAction's doc
 * comment). A first guess, meant to be re-tuned against lib/playtest/scripts/
 * checkFlipRate.ts rather than trusted as correctly calibrated.
 */
const FLIP_THRESHOLD_BIAS_PER_PLAYER = 0.5;

/**
 * Makes flip strictly easier to justify as player count grows past 4, by lowering
 * the bar flip's own average has to clear over the "don't flip" baseline (see
 * chooseHardFastAction) -- unlike effectiveFlipSearchSize, this isn't fixing a bug,
 * it's deliberately biasing the decision because 8p's flip rate stayed well below
 * 4p's even once the search itself was put on equal footing.
 */
function effectiveFlipThreshold(playerCount: number, options: HardFastOptions): number {
  if (playerCount <= 4) return options.flipThreshold;
  return options.flipThreshold - (playerCount - 4) * FLIP_THRESHOLD_BIAS_PER_PLAYER;
}

export function chooseHardFastAction(
  state: GameState,
  playerId: string,
  options: HardFastOptions = DEFAULT_HARD_FAST_OPTIONS,
  rng: Rng = Math.random
): GameAction {
  benchmarkTimings.decisions++;
  const greedyChoice = chooseGreedyAiAction(state, playerId, rng);
  if (greedyChoice.type === "castVote" || greedyChoice.type === "pass") return greedyChoice; // voting/pass -- Medium's existing logic is untouched

  const { flipMaxCandidates, flipRoundsAhead } = effectiveFlipSearchSize(state.config.playerCount, options);
  const flipCandidates = rankedFlipCandidates(state, playerId, flipMaxCandidates);
  if (flipCandidates.length > 0) {
    // `null` as the LEADING entry means "don't flip" -- see this function's own doc
    // comment for why folding it into the same round-robin (instead of comparing a
    // flip candidate's raw average against a fixed constant) is what actually fixes
    // the player-count-dependent flip rate. It goes FIRST, not last: searchBest's
    // round-robin evaluates candidates in array order and can bail out mid-pass once
    // its time budget expires (see searchBest's own loop) -- a trailing baseline only
    // ever got a sample once a FULL pass through every real flip candidate completed
    // first, which a tight flipTimeBudgetMs frequently can't do outside a JIT-warmed
    // benchmark loop. Confirmed live: in a real single game, `averages`' last slot
    // came back `null` on nearly every decision, and baselineAvg !== null is required
    // below before flip can ever be chosen -- so flipping was silently almost always
    // blocked. Leading position guarantees baseline gets at least the first sample of
    // every pass, same as any other candidate would if it went first.
    const withBaseline: (CardInstance | null)[] = [null, ...flipCandidates];
    const flipSearch = searchBest(
      withBaseline,
      (target) => (target ? { type: "flip", playerId, instanceId: target.instanceId } : null),
      flipRoundsAhead,
      options.flipTimeBudgetMs,
      options.flipMaxPasses ?? Infinity,
      state,
      playerId,
      rng
    );
    if (flipSearch) {
      const baselineAvg = flipSearch.averages[0];
      let bestFlipIdx = -1;
      let bestFlipAvg = -Infinity;
      for (let i = 0; i < flipCandidates.length; i++) {
        const avg = flipSearch.averages[i + 1];
        if (avg === null) continue;
        if (avg > bestFlipAvg) {
          bestFlipAvg = avg;
          bestFlipIdx = i;
        }
      }
      const flipThreshold = effectiveFlipThreshold(state.config.playerCount, options);
      if (bestFlipIdx !== -1 && baselineAvg !== null && bestFlipAvg > baselineAvg + flipThreshold) {
        const target = flipCandidates[bestFlipIdx];
        return { type: "flip", playerId, instanceId: target.instanceId };
      }
    }
  }

  const placementCandidates = rankedPlacementCandidates(state, playerId, options.maxCandidates);
  const placementResult =
    placementCandidates.length > 1
      ? searchBest(placementCandidates, (c) => ({ type: "place", playerId, ...c }), options.roundsAhead, options.timeBudgetMs, options.maxPasses ?? Infinity, state, playerId, rng)
      : null;

  return placementResult?.action ?? greedyChoice;
}

/**
 * Expert's vote decision -- replaces computeAiVote's static current-margin snapshot
 * (see endgame.ts) with a real simulated comparison between "end now" and "continue",
 * round-robined against each other over the shared voteTimeBudgetMs (same round-robin
 * shape searchBest uses for placement/flip candidates, just two options here instead
 * of a candidate list, and varying roundsAhead per option rather than the action).
 *
 * Both options go through the SAME evaluateCandidateOnce call -- initialAction null
 * either way, since there's no placement/flip to apply first, just this pending vote
 * resolving one way or the other -- and therefore the SAME determinize() on every
 * sample. "End now" is just roundsAhead=0: skip the forward-rollout loop entirely and
 * score the freshly-determinized board immediately. This is deliberate, not
 * incidental -- an earlier version scored "end now" straight off trueValues(state),
 * the real authoritative board with every hidden card's TRUE identity, while
 * "continue" only ever saw a fair, fog-of-war-respecting determinized guess. That
 * mismatch let "end now" quietly cheat: the acting player doesn't actually know
 * what's under their opponents' face-down cards any more for an end-now decision than
 * for a continue decision, so comparing an omniscient number against a foggy estimate
 * biased the comparison rather than fairly measuring which option this player should
 * actually prefer given what they truly know. Sampling both the same way (many
 * independent determinize() guesses, averaged) fixes that -- and averaging several
 * guesses for "end now" instead of reading the board once also means one lucky/unlucky
 * guess about a hidden neighbor can't dominate the estimate, same noise-reduction
 * reasoning as any other candidate's average here.
 *
 * Votes yes only when ending now isn't worse than continuing -- deliberately a hard
 * comparison, not a probability curve like computeAiVote's marginToVoteYesProbability:
 * every other decision in this file already just takes whichever averaged best with no
 * artificial randomization layered on top, and the natural sample-to-sample noise from
 * re-determinizing is variability enough.
 *
 * Called by the injected computeVote hook (see game.ts's applyAction/advanceTurn and
 * difficulty.ts's computeVoteForDifficulty) -- not gated on `state.phase === "voting"`
 * here since that's guaranteed by the only real call site.
 */
export function chooseExpertVote(state: GameState, playerId: string, options: HardFastOptions = DEFAULT_HARD_FAST_OPTIONS, rng: Rng = Math.random): boolean {
  const roundsAheadByOption = [0, options.voteRoundsAhead]; // [end now, continue]
  const totals = roundsAheadByOption.map(() => ({ sum: 0, count: 0 }));
  const deadline = performance.now() + options.voteTimeBudgetMs;
  const maxPasses = options.voteMaxPasses ?? Infinity;
  let passes = 0;

  outer: while (performance.now() < deadline && passes < maxPasses) {
    for (let i = 0; i < roundsAheadByOption.length; i++) {
      if (performance.now() >= deadline) break outer;
      const value = evaluateCandidateOnce(state, playerId, null, roundsAheadByOption[i], rng);
      if (value === null) continue; // this determinized guess made something illegal -- doesn't count as a sample
      totals[i].sum += value;
      totals[i].count++;
    }
    passes++;
  }

  const [endNow, continued] = totals;
  // Either option never got a single sample within budget (an extremely tight budget
  // edge case) -- fall back to Medium's own heuristic, same "fall back to Medium"
  // pattern chooseHardFastAction's own bestIdx === -1 case uses.
  if (endNow.count === 0 || continued.count === 0) return computeAiVote(state, playerId, rng);
  return endNow.sum / endNow.count >= continued.sum / continued.count;
}
