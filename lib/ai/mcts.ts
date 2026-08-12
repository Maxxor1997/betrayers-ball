import { copiesForPlayerCount, CARD_DEFS } from "../content/cards";
import { shuffle } from "../engine/deck";
import { computeAiVote, computeGameResult, estimateMargin } from "../engine/endgame";
import { applyAction } from "../engine/game";
import { currentPlayerId, getLegalFlipTargets, getLegalPlacementCells, mustPass } from "../engine/turns";
import { CardId, GameAction, GameState, posKey } from "../engine/types";
import { chooseGreedyAiAction, placementHeuristicAdjustment } from "./greedyAi";

export type Rng = () => number;

export interface MctsOptions {
  /** Wall-clock budget for one decision, not an iteration count -- so play strength degrades gracefully instead of the search either overrunning or leaving iterations on the table, same reasoning as the AI Arena spike that validated this shape (see lib/ai/mcts.test.ts and the perf notes below). */
  timeBudgetMs: number;
  /** Total plies simulated per iteration (tree portion + rollout portion combined) before falling back to a static evaluation -- caps the cost of a single iteration regardless of how long the real game might otherwise run. */
  maxSimulationDepth: number;
  /** UCB1 exploration constant -- higher favors trying under-visited actions, lower favors exploiting the current best-known one. 1.4 (~sqrt(2)) is the standard default. */
  explorationConstant: number;
  /**
   * Optional hard cap on iteration count, independent of timeBudgetMs -- real play
   * never needs this (Infinity), but timeBudgetMs alone makes iteration count (and
   * therefore how many times `rng` gets called) depend on real wall-clock timing,
   * which varies run to run even with an identical seed. Tests that need reproducible
   * output set this to a small fixed number instead.
   */
  maxIterations?: number;
}

/**
 * Tuned from the latency spike that preceded this module (see conversation/commit
 * history, not re-derived here): 250ms comfortably hides inside the existing
 * AI_TURN_DELAY_MS/550ms pacing beat both single-player and multiplayer already use
 * between AI actions. maxSimulationDepth is deliberately smaller than the original
 * spike's (10, not 16) because every node's candidates now get ranked before search
 * even starts (see MAX_CANDIDATES_PER_NODE/rankedActionsAt) and the rollout tail uses
 * chooseGreedyAiAction, not a free random policy -- both meaningfully more expensive
 * per simulated ply than the original all-random design, so the depth cap comes down
 * to keep a single iteration's cost bounded. This trades iteration *count* for
 * iteration *quality*: an early version of this module used a much cheaper random
 * rollout policy and unranked (fully-branching) node expansion, and despite buying
 * thousands of iterations per decision, measured no meaningful improvement over Medium
 * in AI Arena testing -- the working theory is that random-rollout outcomes are a poor
 * value signal for a game with several cards whose payoff depends on deliberate setup
 * (Commander needing an adjacent Footman, etc., see greedyAi.ts's
 * placementHeuristicAdjustment), and that the large raw branching factor (hand size x
 * legal cells) left many candidates under-sampled even at high iteration counts.
 */
export const DEFAULT_MCTS_OPTIONS: MctsOptions = {
  timeBudgetMs: 250,
  maxSimulationDepth: 10,
  explorationConstant: 1.4,
};

/**
 * Caps how many of a node's legal actions ever get a chance to be searched at all --
 * see rankedActionsAt. Without this, a node's branching factor (hand size x legal
 * cells, potentially 100+ at high player counts) can exceed the number of iterations
 * the time budget affords, meaning most candidates get zero or one sample before the
 * search runs out of budget: closer to "try everything once, keep whichever looked
 * lucky" than a real search. Kept modest (not, say, 4-5) so genuinely different lines
 * still get compared, not just minor variations of the single best-ranked idea.
 */
const MAX_CANDIDATES_PER_NODE = 12;

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
 * This is what lets the search simulate full-information turns internally (an
 * opponent's simulated move needs to know what's actually in their hand to be worth
 * anything) without the search ever depending on secretly knowing which hidden card
 * really is which -- it only ever sees one honest sample of what's possible.
 *
 * Called fresh every single iteration (see runIteration), not once for the whole
 * search -- this is the "Information Set MCTS" approach: the tree's nodes/statistics
 * are keyed by action history (see TreeNode), which is the same regardless of which
 * hidden cards turn out to be which, so the same tree accumulates evidence across many
 * independently-guessed worlds instead of every iteration reasoning about one single,
 * possibly-wrong guess. That earlier single-guess-per-search shape risked "strategy
 * fusion" -- confidently committing to a plan that only works if one specific guess
 * about hidden cards happens to be right -- which per-iteration resampling avoids: a
 * bad guess only taints the one iteration it was used for, and averages out across
 * however many other iterations guessed differently.
 */
export function determinize(state: GameState, viewerId: string, rng: Rng): GameState {
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

/** Every action legally available to whoever's turn it currently is -- flip(s), then place-or-pass, exactly the same two-decision-point shape a real turn has (see turns.ts/game.ts). */
function legalActionsAt(state: GameState): GameAction[] {
  const playerId = currentPlayerId(state);
  const actions: GameAction[] = [];
  for (const target of getLegalFlipTargets(state)) actions.push({ type: "flip", playerId, instanceId: target.instanceId });

  if (mustPass(state)) {
    actions.push({ type: "pass", playerId });
  } else {
    const player = state.players.find((p) => p.id === playerId)!;
    for (const card of player.hand) {
      for (const position of getLegalPlacementCells(state)) actions.push({ type: "place", playerId, instanceId: card.instanceId, position });
    }
  }
  return actions;
}

/**
 * Same action set as legalActionsAt, but capped to the MAX_CANDIDATES_PER_NODE
 * highest-ranked ones once there are more than that many -- ranked by exactly the
 * scoring Medium's own choosePlacement uses (estimateMargin + placementHeuristicAdjustment
 * for a placement, plain estimateMargin for flip/pass), from the perspective of
 * whoever's turn it is at this node. This isn't the search's final answer -- UCB still
 * decides which of these survivors actually gets played, informed by real simulated
 * outcomes -- it's just deciding which options are worth spending any of the search
 * budget on in the first place, the same way a strong human wouldn't seriously weigh
 * every legal move, only the ones that look plausible at a glance.
 */
function rankedActionsAt(state: GameState, rng: Rng): GameAction[] {
  const actions = legalActionsAt(state);
  if (actions.length <= MAX_CANDIDATES_PER_NODE) return actions;

  const playerId = currentPlayerId(state);
  const scored = actions.map((action) => {
    const postState = applyAction(state, action, rng);
    const score = action.type === "place" ? estimateMargin(postState, playerId) + placementHeuristicAdjustment(state, playerId, action, postState) : estimateMargin(postState, playerId);
    return { action, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_CANDIDATES_PER_NODE).map((s) => s.action);
}

function actionKey(action: GameAction): string {
  switch (action.type) {
    case "flip":
      return `flip:${action.instanceId}`;
    case "place":
      return `place:${action.instanceId}:${posKey(action.position)}`;
    case "pass":
      return "pass";
    case "castVote":
      return `vote:${action.vote}`;
  }
}

/**
 * A voting phase isn't a decision point the search plans around -- see game.ts, votes
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

/** Each player's total if the game were scored exactly as `state` currently stands -- a live snapshot (same caveat as estimatedResolutionFor: neighbor-dependent effects can still shift as more of the board fills in), used as the cutoff evaluation once a search iteration hits its depth cap without the game actually ending. Unlike estimateMargin, this reads every card's TRUE identity, which is fine here -- everything in a determinized state is "true" by construction for that one sample. */
function trueValues(state: GameState): Record<string, number> {
  if (state.phase === "ended") return state.result!.scores;
  const playerIds = state.players.map((p) => p.id);
  return computeGameResult(state.board, state.config.boardBounds, state.round, playerIds, state.config.centerEffect).scores;
}

function ucbScore(totalValue: number, visits: number, parentVisits: number, explorationConstant: number): number {
  if (visits === 0) return Infinity;
  return totalValue / visits + explorationConstant * Math.sqrt(Math.log(parentVisits) / visits);
}

/**
 * A node no longer stores a concrete GameState or a frozen action list -- both would
 * only be valid for the one determinized world that existed when the node was first
 * created, which is exactly the single-guess-per-search shape this module moved away
 * from (see determinize's doc comment). Instead a node is purely a point in the game's
 * *action history* (identified by the chain of actionKeys from the root down to it),
 * and its stats/children are shared across every iteration's independently-guessed
 * world -- each iteration reconstructs its own concrete state by determinizing fresh
 * and replaying that same action history against it (see runIteration). This works
 * because an action's identity (instanceId/position) is stable across every
 * determinization -- determinize never touches instanceId, ownerId, or position, only
 * cardId -- so "the action that was child #2 here in a past iteration" still means the
 * exact same move in this iteration's freshly-guessed world, even though the specific
 * card it turns out to be may differ.
 */
interface TreeNode {
  children: Map<string, { action: GameAction; child: TreeNode }>;
  visits: number;
  /** Per-player running total of every rollout outcome that passed through this node -- a vector, not a single scalar, since this isn't a 2-player zero-sum game: each player's own component is what THEIR selection step (when it's their turn to act at this node) maximizes -- the standard "paranoid"/maxⁿ adaptation of UCT to more than two players. */
  totalValueByPlayer: Record<string, number>;
}

function makeNode(): TreeNode {
  return { children: new Map(), visits: 0, totalValueByPlayer: {} };
}

/**
 * One select→expand→rollout→backpropagate pass, mutating `root`'s subtree in place.
 * Determinizes its own fresh hidden-card guess from `realRootState` (see determinize's
 * doc comment on why this happens every iteration, not once for the whole search), then
 * walks the shared tree, applying each chosen action to its own local `state` --
 * `node`/`state` always stay in lockstep, `node` tracking where this iteration is in
 * the shared action-history tree and `state` tracking the concrete consequences of that
 * history in this iteration's own guessed world.
 */
function runIteration(root: TreeNode, realRootState: GameState, playerId: string, options: MctsOptions, rng: Rng): void {
  let state = determinize(realRootState, playerId, rng);
  const path: TreeNode[] = [root];
  let node = root;
  let depth = 0;

  // Selection, then a single expansion -- standard MCTS grows the tree by exactly one
  // new leaf per iteration; going deeper than that leaf happens via later iterations'
  // selection phase revisiting it, not by expanding multiple levels in one pass.
  while (state.phase === "playing" && depth < options.maxSimulationDepth) {
    const candidates = rankedActionsAt(state, rng); // this iteration's own world -- ranking can legitimately differ iteration to iteration
    const untried = candidates.find((a) => !node.children.has(actionKey(a)));
    if (untried) {
      state = resolvePendingVotes(applyAction(state, untried, rng), rng);
      const child = makeNode();
      node.children.set(actionKey(untried), { action: untried, child });
      path.push(child);
      node = child;
      depth++;
      break;
    }
    if (node.children.size === 0) break; // no legal actions at all -- shouldn't happen while "playing", but don't loop forever

    // UCB among children already discovered by ANY past iteration's world, not just
    // this one's -- an action's legality (by instanceId/position) is world-invariant
    // even though which world first surfaced it as a top-ranked candidate isn't.
    const activePlayer = currentPlayerId(state);
    const parentVisits = Math.max(1, node.visits);
    let bestChild: TreeNode | null = null;
    let bestAction: GameAction | null = null;
    let bestScore = -Infinity;
    for (const { action, child } of node.children.values()) {
      const score = ucbScore(child.totalValueByPlayer[activePlayer] ?? 0, child.visits, parentVisits, options.explorationConstant);
      if (score > bestScore) {
        bestScore = score;
        bestChild = child;
        bestAction = action;
      }
    }
    state = resolvePendingVotes(applyAction(state, bestAction!, rng), rng);
    node = bestChild!;
    path.push(node);
    depth++;
  }

  // Rollout: chooseGreedyAiAction (Medium's real decision function) for whatever's
  // left of the depth budget -- an earlier version of this module used a free uniform-
  // random policy here, which bought far more iterations per decision but, per AI
  // Arena testing, produced no real strength gain over Medium: a random rollout rarely
  // sets up the deliberate multi-turn plays several cards depend on (see
  // MAX_CANDIDATES_PER_NODE's doc comment), so the search's own outcome estimates were
  // systematically misleading regardless of how many of them there were. A real
  // (if costlier) policy here trades iteration count for iteration trustworthiness.
  while (state.phase === "playing" && depth < options.maxSimulationDepth) {
    const activeId = currentPlayerId(state);
    const action = chooseGreedyAiAction(state, activeId, rng);
    state = resolvePendingVotes(applyAction(state, action, rng), rng);
    depth++;
  }

  const values = trueValues(state);
  for (const n of path) {
    n.visits++;
    for (const [pid, value] of Object.entries(values)) {
      n.totalValueByPlayer[pid] = (n.totalValueByPlayer[pid] ?? 0) + value;
    }
  }
}

/**
 * Hard difficulty's decision function -- same (state, playerId, rng) -> GameAction
 * call convention as chooseGreedyAiAction/chooseRandomAiAction, so it's a drop-in
 * strategy for chooseAiActionForDifficulty. Runs a determinized, depth-capped,
 * multiplayer-aware UCT search (see determinize/runIteration above) for
 * `options.timeBudgetMs`, then plays whichever of the current decision's actions was
 * visited most -- the standard "robust child" choice, since visit count reflects how
 * much the search actually trusted a line, not just a possibly-noisy one-off average.
 */
export function chooseMctsAction(state: GameState, playerId: string, options: MctsOptions = DEFAULT_MCTS_OPTIONS, rng: Rng = Math.random): GameAction {
  if (state.phase === "voting") {
    if (playerId in state.votes) throw new Error(`${playerId} has already voted`);
    return { type: "castVote", playerId, vote: computeAiVote(state, playerId, rng) };
  }
  if (playerId !== currentPlayerId(state)) {
    throw new Error(`It is not ${playerId}'s turn`);
  }

  const rootActions = legalActionsAt(state);
  if (rootActions.length <= 1) return rootActions[0]; // forced move -- nothing to search

  const root = makeNode();
  const deadline = performance.now() + options.timeBudgetMs;
  const maxIterations = options.maxIterations ?? Infinity;
  let iterations = 0;
  while (performance.now() < deadline && iterations < maxIterations) {
    runIteration(root, state, playerId, options, rng);
    iterations++;
  }

  let bestAction: GameAction = rootActions[0];
  let bestVisits = -1;
  for (const { action, child } of root.children.values()) {
    if (child.visits > bestVisits) {
      bestVisits = child.visits;
      bestAction = action;
    }
  }
  return bestAction;
}
