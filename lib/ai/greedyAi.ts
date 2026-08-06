import { parsePosKey } from "../engine/board";
import { computeAiVote, estimateMargin } from "../engine/endgame";
import { applyPlace, currentPlayerId, getLegalFlipTargets, getLegalPlacementCells } from "../engine/turns";
import { CardInstance, GameAction, GameState, Position } from "../engine/types";

export type Rng = () => number;

/** Picks the highest-scoring option, breaking ties randomly. */
function pickBest<T>(options: T[], score: (option: T) => number, rng: Rng): T {
  let best: T[] = [];
  let bestScore = -Infinity;
  for (const option of options) {
    const s = score(option);
    if (s > bestScore) {
      bestScore = s;
      best = [option];
    } else if (s === bestScore) {
      best.push(option);
    }
  }
  return best[Math.floor(rng() * best.length)];
}

/**
 * Baseline chance of flipping an opponent's card speculatively, when no own-card flip
 * is worth it -- see the note in chooseFlip on why this can't be value-ranked. Set
 * high, not 50/50: only Gloryseeker clearly wants to stay hidden for its owner (+3 face-
 * up), so revealing is very rarely a gift to them, and the information is otherwise
 * free -- a real player grabs it almost every time rather than passing on a free look.
 */
const OPPONENT_FLIP_EXPLORATION_PROBABILITY = 0.85;

function hypotheticalFlipMargin(state: GameState, playerId: string, target: { instanceId: string }): number {
  const board = new Map(state.board);
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  board.set(entry[0], { ...entry[1], faceUp: true });
  return estimateMargin({ ...state, board }, playerId);
}

/**
 * Manhattan distance from `target` to the nearest of the AI's own cards, negated so
 * higher (closer to 0) ranks better -- used to rank blind opponent flip targets. The
 * AI can't know an opponent's hidden identity before flipping, but a card touching (or
 * near) its own board presence is still worth more to reveal than one off in a corner:
 * several of the AI's cards (Berserker, Mercenary, Commander, Bannerman...) score off a
 * neighbor's or the board's true identity, and those evaluations stay blind to a hidden
 * card nearby until it's flipped. A neighbor (distance 1) is the closest a non-own
 * card can be, so it naturally ranks first; ties -- including "no own cards yet" --
 * fall back to pickBest's random tiebreak.
 */
function opponentTargetPriority(board: GameState["board"], playerId: string, target: CardInstance): number {
  const entry = [...board.entries()].find(([, c]) => c.instanceId === target.instanceId)!;
  const pos = parsePosKey(entry[0]);
  let nearestOwnDistance = Infinity;
  for (const [key, c] of board.entries()) {
    if (c.ownerId !== playerId) continue;
    const otherPos = parsePosKey(key);
    const distance = Math.abs(otherPos.x - pos.x) + Math.abs(otherPos.y - pos.y);
    if (distance < nearestOwnDistance) nearestOwnDistance = distance;
  }
  return -nearestOwnDistance;
}

/**
 * Cards whose own printed effect doesn't care about their own face state at all --
 * Berserker's and Warlord's `valueModifier`s count matching cardIds straight off
 * `board.values()` with no `faceUp` check, so flipping either face-up changes nothing
 * about the owner's own margin (hypotheticalFlipMargin always comes back equal to
 * baseline for these, so the margin-ranked branch above never picks them). The only
 * reason a human flips one is the social move this models: showing it off to bait
 * opponents into playing/revealing a matching card of their own, which *does* help --
 * once it's visible, Berserker/Warlord's real bonus/penalty starts applying. Pure
 * bluffing, so it isn't margin-driven; it's a flat chance instead, same shape as
 * SPECULATIVE_CARD_IDS below.
 */
const BLUFF_FLIP_CARD_IDS = new Set(["Berserker", "Warlord"]);

/** Chance, each time the AI has an eligible face-down bluff card of its own, that it reveals one instead of doing the usual margin/exploration flip. */
const BLUFF_FLIP_PROBABILITY = 0.25;

/**
 * Flips the target that improves the (fair) margin the most -- but only among the
 * player's own face-down cards, which they already know the identity of, so ranking
 * them by true post-flip value is fair. An opponent's face-down cards can't be ranked
 * this way without peeking (their true post-flip value literally requires knowing
 * their hidden identity first) -- so a flip target there, if any, is chosen instead of
 * a value-driven one, blind, weighted toward targets adjacent to the AI's own cards, at
 * a flat exploration rate.
 */
function chooseFlip(state: GameState, playerId: string, rng: Rng): string | null {
  const targets = getLegalFlipTargets(state);
  if (targets.length === 0) return null;

  const ownTargets = targets.filter((t) => t.ownerId === playerId);
  const opponentTargets = targets.filter((t) => t.ownerId !== playerId);

  const baseline = estimateMargin(state, playerId);
  let bestOwnTargets: string[] = [];
  let bestOwnScore = baseline;

  for (const target of ownTargets) {
    const score = hypotheticalFlipMargin(state, playerId, target);
    if (score > bestOwnScore) {
      bestOwnScore = score;
      bestOwnTargets = [target.instanceId];
    } else if (score === bestOwnScore && score > baseline) {
      bestOwnTargets.push(target.instanceId);
    }
  }

  if (bestOwnTargets.length > 0) {
    return bestOwnTargets[Math.floor(rng() * bestOwnTargets.length)];
  }

  const bluffTargets = ownTargets.filter((t) => BLUFF_FLIP_CARD_IDS.has(t.cardId));
  if (bluffTargets.length > 0 && rng() < BLUFF_FLIP_PROBABILITY) {
    return bluffTargets[Math.floor(rng() * bluffTargets.length)].instanceId;
  }

  if (opponentTargets.length > 0 && rng() < OPPONENT_FLIP_EXPLORATION_PROBABILITY) {
    const best = pickBest(
      opponentTargets,
      (target) => opponentTargetPriority(state.board, playerId, target),
      rng
    );
    return best.instanceId;
  }

  return null;
}

/**
 * Cards worth playing speculatively, ahead of what pure margin math justifies --
 * effects whose payoff depends on other players following suit, so nobody's ever the
 * first to play one on merit alone (a real human will gamble on it anyway, hoping to
 * bait others; the 1-ply greedy AI can't see that far ahead, so it needs a nudge).
 * Currently just Berserker (+2 per opposing Berserker) -- extend this set if other
 * cards get the same "worthless until someone else follows" shape.
 */
const SPECULATIVE_CARD_IDS = new Set(["Berserker"]);

/** Chance, each time the AI has a speculative card in hand, that it plays that card instead of the margin-best one. */
const SPECULATIVE_PLAY_PROBABILITY = 0.25;

/** Places whichever (card, cell) combination yields the best resulting margin. */
function choosePlacement(state: GameState, playerId: string, rng: Rng): GameAction {
  const player = state.players.find((p) => p.id === playerId)!;
  const legalCells = getLegalPlacementCells(state);
  if (player.hand.length === 0 || legalCells.length === 0) {
    return { type: "pass", playerId };
  }

  let handForCandidates = player.hand;
  const speculativeCards = player.hand.filter((c) => SPECULATIVE_CARD_IDS.has(c.cardId));
  if (speculativeCards.length > 0 && rng() < SPECULATIVE_PLAY_PROBABILITY) {
    handForCandidates = speculativeCards;
  }

  const candidates: { instanceId: string; position: Position }[] = [];
  for (const card of handForCandidates) {
    for (const position of legalCells) {
      candidates.push({ instanceId: card.instanceId, position });
    }
  }

  const best = pickBest(
    candidates,
    (candidate) => estimateMargin(applyPlace(state, { type: "place", playerId, ...candidate }), playerId),
    rng
  );

  return { type: "place", playerId, instanceId: best.instanceId, position: best.position };
}

/**
 * Same call convention as chooseAiAction in randomAi.ts (state, playerId, rng) ->
 * GameAction, so it's a drop-in replacement -- a turn is still up to two calls (an
 * optional flip, then always a place/pass), and a pending vote is handled the same way.
 * All scoring goes through the engine's fair, per-player evaluation (endgame.ts) --
 * this module never reads an opponent's hidden card identity directly.
 */
export function chooseGreedyAiAction(state: GameState, playerId: string, rng: Rng = Math.random): GameAction {
  if (state.phase === "voting") {
    if (playerId in state.votes) throw new Error(`${playerId} has already voted`);
    return { type: "castVote", playerId, vote: computeAiVote(state, playerId, rng) };
  }

  if (playerId !== currentPlayerId(state)) {
    throw new Error(`It is not ${playerId}'s turn`);
  }

  const flipInstanceId = chooseFlip(state, playerId, rng);
  if (flipInstanceId) {
    return { type: "flip", playerId, instanceId: flipInstanceId };
  }

  return choosePlacement(state, playerId, rng);
}
