import { copiesForPlayerCount, CARD_DEFS } from "../content/cards";
import { shuffle } from "../engine/deck";
import { computeAiVote, computeGameResult, estimateMargin } from "../engine/endgame";
import { applyAction } from "../engine/game";
import { applyPlace, currentPlayerId, getLegalPlacementCells } from "../engine/turns";
import { CardId, GameAction, GameState, Position } from "../engine/types";
import { chooseGreedyAiAction, placementHeuristicAdjustment } from "./greedyAi";

export type Rng = () => number;

/**
 * Minimal, purely additive sample-count bookkeeping -- deliberately not the full
 * wall-clock timing breakdown hardFast.ts's own benchmarkTimings has (that file's
 * whole purpose is speed experimentation; this exists only so AI Arena's fixed-per-
 * seat mode can show "how many samples per candidate is this seat actually getting"
 * for a real Hard seat too, not just Fast fork ones -- see aiArena.ts's
 * dispatchArenaSeatAction). Never read or branched on by chooseTwoPlyAction itself --
 * this file's actual decision-making behavior is completely unaffected.
 */
export const twoPlySearchStats = {
  /** evaluateCandidateOnce calls, across every decision. */
  samples: 0,
  /** Sum of candidates.length across every decision that actually ran the round-robin loop (i.e. had more than one candidate to compare) -- the denominator for "samples per candidate". */
  candidatesEvaluated: 0,
};

export function resetTwoPlySearchStats(): void {
  twoPlySearchStats.samples = 0;
  twoPlySearchStats.candidatesEvaluated = 0;
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
 * present during a hypothetical simulation to actually answer), resolve every still-
 * pending vote immediately with the engine's own computeAiVote so the walk can keep
 * going -- this always terminates, since applyAction's castVote path tallies and
 * leaves "voting" the moment the last vote comes in.
 */
function resolvePendingVotes(state: GameState, rng: Rng): GameState {
  let s = state;
  while (s.phase === "voting") {
    const pending = s.players.find((p) => !(p.id in s.votes));
    if (!pending) break;
    s = applyAction(s, { type: "castVote", playerId: pending.id, vote: computeAiVote(s, pending.id, rng) }, rng);
  }
  return s;
}

/** Each player's total if the game were scored exactly as `state` currently stands -- a live snapshot (neighbor-dependent effects can still shift as more of the board fills in), used once a simulated round finishes without the game actually ending. Reads every card's TRUE identity, which is fine here -- everything in a determinized state is "true" by construction for that one sample. */
function trueValues(state: GameState): Record<string, number> {
  if (state.phase === "ended") return state.result!.scores;
  const playerIds = state.players.map((p) => p.id);
  return computeGameResult(state.board, state.config.boardBounds, state.round, playerIds, state.config.centerEffect).scores;
}

export interface TwoPlyOptions {
  /** Wall-clock budget for the placement decision -- see chooseTwoPlyAction's doc comment for why placement is the only decision this touches. */
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
 * 250ms hides inside the existing AI_TURN_DELAY_MS/550ms pacing beat both single-
 * player and multiplayer already use between AI actions. maxCandidates=8,
 * roundsAhead=1 is the config validated by AI Arena testing -- a real, consistent
 * ~3-4 point win-rate edge over Medium across two separate large (n=400, n=1236)
 * samples at this exact budget. A deeper/narrower variant (roundsAhead=3,
 * maxCandidates=4) was tried and measured worse (n=1000, statistically indistinguishable
 * from Medium) -- tripling the simulated depth tripled each sample's cost, and cutting
 * maxCandidates to compensate didn't leave enough independent samples per candidate to
 * average out the noise; the extra rounds also meant more exposure to Medium's own
 * simulated-opponent inaccuracy compounding across turns, rather than more signal.
 * Reverted back to this shallower/wider config on that evidence, not a guess.
 */
export const DEFAULT_TWO_PLY_OPTIONS: TwoPlyOptions = {
  timeBudgetMs: 250,
  maxCandidates: 8,
  roundsAhead: 1,
};

/** Same ranking Medium's own choosePlacement uses (estimateMargin + placementHeuristicAdjustment), kept to placements only -- see chooseTwoPlyAction for why flip/pass aren't touched here. Pruning to the top few keeps the round-robin evaluation loop below cheap enough to run several passes within budget. */
function rankedPlacementCandidates(state: GameState, playerId: string, maxCandidates: number): { instanceId: string; position: Position }[] {
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
  return scored.slice(0, maxCandidates).map((s) => s.candidate);
}

/**
 * `roundsAhead` full extra rounds: this candidate placement, then every player's real
 * next turn(s) -- including the acting player's own, via Medium's own
 * chooseGreedyAiAction, the best available stand-in for "what a decent player actually
 * does next" -- for as many rounds as requested, evaluated against the real resulting
 * totals of one freshly-determinized hidden-info guess. Unlike Medium's own
 * estimateMargin (which only ever sees the position immediately after the acting
 * player's own placement, with every future move collapsed into "unknown"), this
 * genuinely looks further ahead and sees a concrete, played-out consequence. Uses
 * GameState.round (not "count turns until it's playerId's turn again") to detect a
 * completed round -- correct regardless of round-start seat rotation, voting, or a
 * center effect like Reckoning redrawing hands at round 4, since all of that is
 * already reflected in `round` by the time it ticks over.
 */
function evaluateCandidateOnce(state: GameState, playerId: string, candidate: { instanceId: string; position: Position }, roundsAhead: number, rng: Rng): number {
  twoPlySearchStats.samples++;
  let s = resolvePendingVotes(applyAction(determinize(state, playerId, rng), { type: "place", playerId, ...candidate }, rng), rng);
  const targetRound = s.round + roundsAhead;
  // Generous, player-count-aware safety cap -- not the real stopping condition
  // (targetRound is), just a guard against looping forever if something behaves
  // unexpectedly (e.g. a long pass-chain that never advances the round).
  const maxSteps = roundsAhead * state.players.length * 3;
  let steps = 0;
  while (s.phase === "playing" && s.round < targetRound && steps < maxSteps) {
    const activeId = currentPlayerId(s);
    const action = chooseGreedyAiAction(s, activeId, rng);
    s = resolvePendingVotes(applyAction(s, action, rng), rng);
    steps++;
  }

  const values = trueValues(s);
  const myScore = values[playerId] ?? 0;
  const bestOpponent = Math.max(0, ...state.players.filter((p) => p.id !== playerId).map((p) => values[p.id] ?? 0));
  return myScore - bestOpponent;
}

/**
 * Hard difficulty's decision function -- same (state, playerId, rng) -> GameAction
 * call convention as the other AI strategies, so it's a drop-in for
 * chooseAiActionForDifficulty. Replaces an earlier determinized-MCTS design (see git
 * history) that, per AI Arena testing at n=1400 (real 250ms budget), showed no
 * measurable strength gain over Medium -- the working diagnosis was that MCTS's
 * candidate pruning AND its rollout policy both reused Medium's own evaluation, so its
 * ceiling was architecturally bounded by Medium's own judgment rather than exceeding
 * it. This is a deliberately simpler design that adds a genuinely different signal
 * instead: for the placement decision specifically, actually simulate `options.roundsAhead`
 * full rounds of every player's real response (via chooseGreedyAiAction) and evaluate
 * the resulting position, rather than just trusting Medium's immediate, opponent-blind
 * margin estimate. Flip and pass decisions are untouched -- delegated straight to
 * chooseGreedyAiAction -- since the diagnosed gap was specifically about not seeing
 * what opponents do *after* a placement, not about the flip decision.
 *
 * Candidates are pruned to `options.maxCandidates` (ranked by Medium's own scoring --
 * see rankedPlacementCandidates) and evaluated round-robin -- one pass through every
 * candidate before any candidate gets a second sample -- so a tight time budget still
 * covers every plausible option at least once instead of exhausting itself deep-diving
 * the single best-ranked one. Each sample determinizes its own fresh hidden-info guess
 * (see determinize's doc comment) so no single wrong guess about hidden cards can
 * dominate one candidate's average.
 */
export function chooseTwoPlyAction(state: GameState, playerId: string, options: TwoPlyOptions = DEFAULT_TWO_PLY_OPTIONS, rng: Rng = Math.random): GameAction {
  const greedyChoice = chooseGreedyAiAction(state, playerId, rng);
  if (greedyChoice.type !== "place") return greedyChoice; // voting/flip/pass -- Medium's existing logic is untouched

  const candidates = rankedPlacementCandidates(state, playerId, options.maxCandidates);
  if (candidates.length <= 1) return greedyChoice; // nothing to compare
  twoPlySearchStats.candidatesEvaluated += candidates.length;

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
