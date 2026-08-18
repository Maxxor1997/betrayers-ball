import { ALL_CARD_IDS, CARD_DEFS, copiesForPlayerCount } from "../content/cards";
import { getLegalPlacementPositions, parsePosKey } from "./board";
import { redactedBoardFor } from "./playerView";
import { resolveBoard, ResolutionResult } from "./resolution";
import { Board, BoardBounds, CardId, CardInstance, CenterEffectId, GameResult, GameState } from "./types";

export function isBoardFull(board: Board, bounds: BoardBounds): boolean {
  return getLegalPlacementPositions(board, bounds).length === 0;
}

export function isRoundCapHit(completedRound: number, roundCap: number): boolean {
  return completedRound >= roundCap;
}

/** Board-fill and the round cap end the game unconditionally, checked at a round boundary. */
export function shouldEndGame(board: Board, bounds: BoardBounds, completedRound: number, roundCap: number): boolean {
  return isBoardFull(board, bounds) || isRoundCapHit(completedRound, roundCap);
}

/**
 * How likely an AI is to vote to end the game on a given round -- increases linearly
 * as the game goes on, reaching certainty at the round cap. Not a spec number; a
 * reasonable default for the single-device AI opponent.
 */
export function aiVoteProbability(round: number, roundCap: number): number {
  return Math.min(1, round / roundCap);
}

/**
 * Final scoring: resolves the frozen board and totals each player's owned-card values.
 * Tie-break: the spec (game_spec.md v2) flags final-tie-break as an explicitly missing
 * rule. Default here is a shared win — winnerIds can hold multiple ids on a tie.
 */
export function computeGameResult(
  board: Board,
  bounds: BoardBounds,
  finalRound: number,
  playerIds: string[],
  centerEffect: CenterEffectId = "none"
): GameResult {
  const { totalsByOwner } = resolveBoard(board, bounds, finalRound, centerEffect, playerIds);
  const scores: Record<string, number> = {};
  for (const id of playerIds) scores[id] = totalsByOwner[id] ?? 0;

  const maxScore = Math.max(...playerIds.map((id) => scores[id]));
  const winnerIds = playerIds.filter((id) => scores[id] === maxScore);

  return { scores, winnerIds };
}

/**
 * Full board resolution using only what `viewerId` could actually know -- their own
 * cards (face-up or not) plus anything face-up on the board; an opponent's
 * still-hidden card resolves as the neutral "Unknown" pseudo-card (see
 * redactedBoardFor), never its true effect, so nothing here leaks hidden information.
 * This is a live, provisional resolution, not the final one: because effects are
 * neighbor-dependent, a card's contribution can (and will) change as more of the
 * board fills in around it, so the same call made again next turn can legitimately
 * return different numbers for cards already on the board.
 */
export function estimatedResolutionFor(state: GameState, viewerId: string): ResolutionResult {
  const playerIds = state.players.map((p) => p.id);
  const evaluationBoard = redactedBoardFor(state.board, viewerId);
  return resolveBoard(evaluationBoard, state.config.boardBounds, state.round, state.config.centerEffect, playerIds);
}

/**
 * Deck-wide odds that a still-hidden card (from `viewerId`'s own honest point of view)
 * turns out to be each identity, as a share of the total hidden pool -- "hidden" means
 * not yet identity-known to `viewerId`: not face-up anywhere, not in their own hand
 * (they know their own cards regardless of face state). Deck composition
 * (copiesForPlayerCount) is public, so this needs no information `viewerId` doesn't
 * actually have. Cards with no valueModifier (nothing to contribute to a neighbor) are
 * skipped outright.
 */
function hiddenIdentityWeights(state: GameState, viewerId: string): Map<CardId, number> {
  const viewer = state.players.find((p) => p.id === viewerId)!;
  const weights = new Map<CardId, number>();
  let total = 0;
  for (const cardId of ALL_CARD_IDS) {
    const def = CARD_DEFS[cardId];
    if (def.disabled || !def.valueModifier) continue;
    const totalCopies = copiesForPlayerCount(def, state.config.playerCount);
    if (totalCopies === 0) continue;
    const identityKnown = [...state.board.values()].filter((c) => c.cardId === cardId && (c.faceUp || c.ownerId === viewerId)).length;
    const ownHandCopies = viewer.hand.filter((c) => c.cardId === cardId).length;
    const hidden = Math.max(0, totalCopies - identityKnown - ownHandCopies);
    if (hidden === 0) continue;
    weights.set(cardId, hidden);
    total += hidden;
  }
  if (total > 0) for (const [cardId, hidden] of weights) weights.set(cardId, hidden / total);
  return weights;
}

/**
 * The fair estimate's real blind spot: a still-hidden opposing card's `valueModifier`
 * never runs at all (see redactedBoardFor -- it becomes the inert "Unknown"
 * pseudo-card), so any effect it would eventually land on a *known* neighbor -- a Plague
 * Rat's flood-fill, an Earthshaker's connected-row/column -2, a Bannerman's +1/+2, etc
 * -- is invisible to estimateMargin, even though the neighbor's owner is public
 * information. That silently favors whoever's known cards happen to sit next to the
 * most hidden cards, worst on boards where a lot stays face-down for a long time (e.g.
 * Pit of Erebus's delayed flip gate).
 *
 * Fixed the same way negation's dry-run helper (selfContributionOnly in resolution.ts)
 * works elsewhere in this codebase: for every still-hidden position, temporarily swap
 * in each candidate identity (weighted by hiddenIdentityWeights) and run its *real*
 * valueModifier hook against the real (redacted) board, keeping only the deltas it
 * lands on other, already-known cards -- never the hidden card's own value, which isn't
 * part of anyone's known total yet. This needs no hand-tuned per-card magnitude table:
 * it reuses each card's actual printed rule, so it automatically respects every
 * condition that rule already checks (Earthshaker's real connected row/column,
 * Truthseeker's real face-down check, Suppressor's real neighbor count, ...) and nets
 * out positive for cards like Bannerman just as correctly as it nets out negative for
 * the Control bucket's penalty cards -- no assumption here that hidden cards skew
 * harmful, only that they skew *unaccounted for*. (Facestealer is a deliberate
 * exception: its identity swap isn't a valueModifier at all anymore -- see
 * lib/content/cards.ts and resolution.ts's computeIdentitySwaps -- so it's naturally
 * excluded from hiddenIdentityWeights below, which only considers cards with one.)
 *
 * Returns the total expected adjustment per owner (added to totalsByOwner), not a
 * per-card breakdown -- this stays purely an estimateMargin input, deliberately not
 * plumbed into estimatedResolutionFor/its UI, since that surface promises its shown
 * total exactly matches the sum of its shown per-card breakdown.
 */
function expectedHiddenNeighborAdjustments(state: GameState, viewerId: string): Map<string, number> {
  const adjustments = new Map<string, number>();
  const weights = hiddenIdentityWeights(state, viewerId);
  if (weights.size === 0) return adjustments;

  const bounds = state.config.boardBounds;
  const board = redactedBoardFor(state.board, viewerId);
  const ownerByInstanceId = new Map<string, string>();
  for (const c of board.values()) ownerByInstanceId.set(c.instanceId, c.ownerId);

  for (const [key, card] of board.entries()) {
    if (card.cardId !== "Unknown") continue;
    const pos = parsePosKey(key);
    for (const [cardId, weight] of weights) {
      const patchedSelf: CardInstance = { ...card, cardId };
      const patchedBoard: Board = new Map(board);
      patchedBoard.set(key, patchedSelf);
      CARD_DEFS[cardId].valueModifier?.({
        board: patchedBoard,
        bounds,
        round: state.round,
        pos,
        self: patchedSelf,
        addDelta: (instanceId, amount) => {
          if (instanceId === patchedSelf.instanceId) return;
          const ownerId = ownerByInstanceId.get(instanceId);
          if (!ownerId) return;
          adjustments.set(ownerId, (adjustments.get(ownerId) ?? 0) + weight * amount);
        },
      });
    }
  }
  return adjustments;
}

/**
 * A player's own honest estimate of standing: "my total minus the best opponent's
 * total", using only what they could actually know. Shared by the engine's automatic
 * AI vote-fill and by AI turn-decision modules that want a fair evaluation function.
 * Both totals get expectedHiddenNeighborAdjustments folded in, so a card sitting next
 * to a lot of still-hidden opposing cards doesn't read as safer than it really is.
 */
export function estimateMargin(state: GameState, viewerId: string): number {
  const { totalsByOwner } = estimatedResolutionFor(state, viewerId);
  const adjustments = expectedHiddenNeighborAdjustments(state, viewerId);
  const totalFor = (playerId: string) => (totalsByOwner[playerId] ?? 0) + (adjustments.get(playerId) ?? 0);
  const myScore = totalFor(viewerId);
  const bestOther = Math.max(0, ...state.players.filter((p) => p.id !== viewerId).map((p) => totalFor(p.id)));
  return myScore - bestOther;
}

/**
 * How many margin points correspond to one e-fold of odds in the logistic curve below
 * -- smaller means the AI's vote reacts more sharply to a given point gap. 5 was
 * picked so a single mid-value card's worth of lead (e.g. one Footman) noticeably
 * moves the needle without already being a near-certain yes on its own.
 */
const VOTE_MARGIN_SCALE = 5;

/** Floor/ceiling on the yes-vote probability -- keeps the vote genuinely random even at a landslide margin, never fully deterministic either way. */
const MIN_VOTE_YES_PROBABILITY = 0.05;
const MAX_VOTE_YES_PROBABILITY = 0.95;

/**
 * Chance of voting yes, purely as a function of the current fair margin -- a logistic
 * curve centered on 0 (tied game -> 50/50), growing more likely to end the further
 * ahead the AI is and less likely the further behind, clamped so it's never fully
 * certain either way.
 */
function marginToVoteYesProbability(margin: number): number {
  const logistic = 1 / (1 + Math.exp(-margin / VOTE_MARGIN_SCALE));
  return Math.min(MAX_VOTE_YES_PROBABILITY, Math.max(MIN_VOTE_YES_PROBABILITY, logistic));
}

/**
 * Extra margin credit for Dying God, the only card left whose value is a known, exact
 * function of the round -- "what would one more round do to my score" can be answered
 * precisely (-1) instead of guessed at. Its owner is strictly worse off if the game
 * keeps going, so gets a nudge toward voting yes (lock in the current, better value
 * now). Chronicler ("Doomherald") used to get the mirrored nudge here when its own
 * effect was +1/round elapsed -- now that it's "-3 to adjacent cards while face-up,
 * opponent-only flip" (see lib/content/cards.ts), its value has nothing to do with
 * the round anymore, just whether an opponent ever flips it; there's no similarly
 * precise, cheap-to-compute vote nudge for that, so it's left to the plain margin
 * estimate like everything else uncertain. Own cards only -- a still-hidden opponent
 * Dying God might exist too, but there's no fair way to guess that without leaking
 * hidden information, matching every other heuristic in this codebase.
 */
function roundSensitiveVoteAdjustment(state: GameState, playerId: string): number {
  let adjustment = 0;
  for (const c of state.board.values()) {
    if (c.ownerId === playerId && c.cardId === "DyingGod") adjustment += 1;
  }
  return adjustment;
}

/** How many margin points the strongest possible vote-history signal is worth -- kept modest (comparable to the Dying God nudge) since it's a secondary correction to estimateMargin's own blind spot, not a primary driver of the vote. */
const VOTE_HISTORY_ADJUSTMENT_SCALE = 1.5;

/**
 * Corrects a real blind spot in estimateMargin: it only ever prices in *this* player's
 * own redacted view of the board (own hand + visible cards + a fair guess at hidden
 * neighbor identities from expectedHiddenNeighborAdjustments) -- it has no way to know
 * an opponent's actual hand or hidden board cards. But every AI opponent's own vote
 * (computeAiVote, called with their own playerId) IS driven by their true, unredacted
 * margin -- so a recent yes vote from an opponent leaks that they believe their real
 * position is stronger than this player's estimate of them can see. The correction
 * runs opposite to that signal, not with it: the more opponents have recently voted
 * yes, the more this player's own margin gets pulled down (less eager to also vote yes
 * and confirm a lead it can't actually see); the more they've voted no, the less
 * correction is applied (nothing suggests the estimate is missing anything).
 *
 * Only the single most recently tallied round is used, not the whole history -- an
 * opponent's vote from several rounds ago reflects a board that's since changed
 * underneath it, so it's stale evidence about their *current* position. Yields 0
 * before any round has ever been tallied (voteHistory empty) -- there's no signal yet.
 */
function voteHistoryAdjustment(state: GameState, playerId: string): number {
  const lastRound = state.voteHistory[state.voteHistory.length - 1];
  if (!lastRound) return 0;

  const opponentVotes = Object.entries(lastRound.votes).filter(([id]) => id !== playerId);
  if (opponentVotes.length === 0) return 0;

  const opponentYesRate = opponentVotes.filter(([, vote]) => vote).length / opponentVotes.length;
  return -VOTE_HISTORY_ADJUSTMENT_SCALE * (2 * opponentYesRate - 1);
}

/**
 * Vote yes/no off the player's own (fair) margin estimate, via
 * marginToVoteYesProbability, plus roundSensitiveVoteAdjustment for Dying God and
 * voteHistoryAdjustment for what recent opponent votes leak about their real position.
 * Otherwise deliberately ignores the round: whether to end is a fresh decision every
 * time voting comes up, not a countdown; the round cap already force-ends the game on
 * its own once reached, so there's no separate need to ramp pressure by round here too.
 */
export function computeAiVote(state: GameState, playerId: string, rng: () => number): boolean {
  const margin =
    estimateMargin(state, playerId) + roundSensitiveVoteAdjustment(state, playerId) + voteHistoryAdjustment(state, playerId);
  return rng() < marginToVoteYesProbability(margin);
}
