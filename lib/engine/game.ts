import { BOARD_BOUNDS_BY_PLAYER_COUNT } from "@/lib/config/boardSizing";
import { CENTER_EFFECTS } from "@/lib/content/centerEffects";
import { dealNewGame, redrawOffer, Rng } from "./deck";
import { computeAiVote, computeGameResult, shouldEndGame } from "./endgame";
import { applyFlip, applyPass, applyPlace, currentPlayerId, mustPass } from "./turns";
import { AiDifficulty, CastVoteAction, CenterEffectId, GameAction, GameConfig, GameState } from "./types";

/**
 * How advanceTurn decides an AI seat's vote when a round boundary auto-fills it (see
 * its own doc comment) -- defaults to the plain computeAiVote, so every existing
 * caller of applyAction/advanceTurn (every real single-player/multiplayer game, every
 * test) is completely unaffected unless it explicitly passes something else. This is
 * the seam that lets a specific AI difficulty (see lib/ai/difficulty.ts's
 * computeVoteForDifficulty and lib/ai/hardFast.ts's chooseExpertVote) vote differently
 * from computeAiVote's static heuristic, without this engine module needing to know
 * anything about specific AI strategies -- it only ever sees this generic function
 * shape, injected by whichever caller already knows the game's configured difficulty.
 */
export type ComputeVoteFn = (state: GameState, playerId: string, rng: Rng) => boolean;

export function configForPlayerCount(
  playerCount: number,
  centerEffect: CenterEffectId = "none",
  aiDifficulty: AiDifficulty = "medium",
  rng: Rng = Math.random
): GameConfig {
  const baseBounds = BOARD_BOUNDS_BY_PLAYER_COUNT[playerCount];
  if (!baseBounds) throw new Error(`No board sizing configured for ${playerCount} players (supported: 2-6)`);
  // A center effect can override which tiles are ownerless -- baked into boardBounds
  // here, once, so every downstream board.ts lookup that only ever took `bounds` (not
  // centerEffect) keeps working unchanged.
  const ownerlessPositions = CENTER_EFFECTS[centerEffect].ownerlessPositions?.(baseBounds, rng);
  const boardBounds = ownerlessPositions ? { ...baseBounds, ownerless: ownerlessPositions } : baseBounds;
  return {
    boardBounds,
    handSize: 8,
    roundCap: 6,
    // 2p delays the flip unlock by a round -- with only one opponent, a single flip
    // removes all "unknown" for that card faster than in larger games.
    flipUnlockRound: playerCount === 2 ? 3 : 2,
    centerEffect,
    minRoundFloor: 3,
    playerCount,
    aiDifficulty,
  };
}

export const DEFAULT_2P_CONFIG: GameConfig = configForPlayerCount(2);

export function createGame(
  playerIds: string[],
  config: GameConfig = DEFAULT_2P_CONFIG,
  rng?: Rng,
  aiPlayerIds: Iterable<string> = [],
  firstPlayerIndex = 0,
  /**
   * The stable order used for each player's `colorIndex` (see PlayerState's own doc
   * comment) -- defaults to `playerIds` itself, so every existing caller (every
   * single-player game, every test) keeps its current behavior of "seat position ==
   * color" exactly. A caller that wants turn order shuffled independently of color
   * (see GameSession.dealAndStart) passes its own stable seat order here instead.
   */
  colorOrder: string[] = playerIds
): GameState {
  const effectiveRng = rng ?? Math.random;
  // Hall of Fortunes: nobody is dealt a real starting hand -- every player starts
  // empty-handed, and the entire built deck stays undrawn, shared, and face-down in
  // the middle. Each player's actual "hand" only ever exists as their current 3-card
  // offer, redrawn fresh from that shared pool right when it becomes their turn (see
  // redrawOfferForCurrentPlayer below) -- passing handSize 0 here just means nobody's
  // dealt anything upfront; `deal`'s own loop is a no-op at that size, so this needs
  // no changes to deck.ts's dealing itself.
  const handSize = config.centerEffect === "reckoning" ? 0 : config.handSize;
  const { players, remainingDeck } = dealNewGame(playerIds, handSize, effectiveRng);
  const aiIds = new Set(aiPlayerIds);
  const finalPlayers = players.map((p) => ({ ...p, isAI: aiIds.has(p.id), colorIndex: colorOrder.indexOf(p.id) }));
  const state: GameState = {
    config,
    board: new Map(),
    deck: remainingDeck,
    players: finalPlayers,
    currentPlayerIndex: firstPlayerIndex,
    round: 1,
    turnsThisRound: 0,
    passedPlayerIds: new Set(),
    hasFlippedThisTurn: false,
    votes: {},
    voteHistory: [],
    flipHistory: [],
    placementOrder: [],
    handOffers: {},
    phase: "playing",
    result: null,
  };
  // Only the starting player needs an offer right now -- everyone else's gets drawn
  // lazily, the exact same way, the moment turn order actually reaches them (see
  // redrawOfferForCurrentPlayer's own call sites in advanceTurn/tallyVotes below).
  const { players: playersWithOffer, deck, handOffers } = redrawOfferForCurrentPlayer(state, effectiveRng);
  return { ...state, players: playersWithOffer, deck, handOffers };
}

/**
 * Hall of Fortunes only: redraws the current player's offer completely fresh from the
 * shared undrawn pool every single time it becomes their turn -- never a subset of a
 * larger fixed hand, and never reused/persisted from their last turn even if some of
 * it went unplaced (see deck.ts's redrawOffer for exactly how those leftovers get
 * returned to the pool first). A no-op for every other center effect.
 */
function redrawOfferForCurrentPlayer(state: GameState, rng: Rng): Pick<GameState, "players" | "deck" | "handOffers"> {
  if (state.config.centerEffect !== "reckoning") return { players: state.players, deck: state.deck, handOffers: state.handOffers };
  const playerId = currentPlayerId(state);
  const player = state.players.find((p) => p.id === playerId)!;
  const { hand, deck } = redrawOffer(state.deck, player.hand, playerId, rng);
  const players = state.players.map((p) => (p.id === playerId ? { ...p, hand } : p));
  const handOffers = { ...state.handOffers, [playerId]: hand };
  return { players, deck, handOffers };
}

/**
 * Round-start hook for center effects that need one (currently just Reckoning).
 * Round 4 can be entered two different ways (see call sites below), so this is
 * factored out rather than duplicated. See lib/engine/centerEffects.ts.
 */
function applyRoundStart(state: GameState, newRound: number, rng: Rng): Pick<GameState, "players" | "deck"> {
  const onRoundStart = CENTER_EFFECTS[state.config.centerEffect].onRoundStart;
  if (onRoundStart) return onRoundStart(state, newRound, rng);
  return { players: state.players, deck: state.deck };
}

/**
 * Advances to the next player's turn after a place/pass action. Endgame triggers are
 * only checked at a round boundary (after every player has acted this round) — see
 * the LOCKED fairness rule in game_spec.md. Board-fill and the round cap end the game
 * unconditionally; otherwise, from the min-round floor on, every round boundary
 * triggers a vote (see applyCastVote) instead of continuing automatically.
 *
 * A round boundary is "turnsThisRound reaches player count", not "currentPlayerIndex
 * wraps to 0" -- turn order rotates continuously through indices, not resetting to 0
 * each round, so with a non-zero starting player (see firstPlayerIndex) the old
 * index-based check fired after just one turn instead of after everyone had gone.
 *
 * `roundRotationShift` is the one deliberate exception to "continuously": at a round
 * boundary only, for 3+ players, the next round starts one seat further than it
 * otherwise would have. Without this, the same seat starts every single round for the
 * whole game (since incrementing by 1 every turn naturally wraps back to the same
 * start each round) -- measured via the AI Arena tool to give whoever acts latest in
 * the turn order a real, growing-with-player-count edge (more accumulated board
 * information to place against by the time it's their turn). A full reversing "snake"
 * order was considered instead and rejected: it makes one seat go twice in a row at
 * every round boundary (the last actor of one round is the first actor of the next),
 * which would let that player chain two placements together with no opponent turn in
 * between -- exploitable with adjacency-synergy cards, worse than the bias it fixes.
 * A 1-seat rotation never produces that: the last actor of round r is seat
 * `(start_r - 1) mod n`, the first actor of round r+1 is `(start_r + 1) mod n`, and
 * those only coincide when n divides 2 -- i.e. only at n <= 2, which is exactly the
 * case excluded below (its measured bias was within noise anyway, so there's nothing
 * to fix there, and rotating would just reintroduce the same back-to-back problem).
 *
 * The shift amount is 1 seat for every player count except 8, which uses 3. This came
 * out of modeling each position's total turn-order "exposure" (early vs late slot)
 * summed across all `roundCap` (6) rounds: a shift of 1 seat/round only completes a
 * full rotation cycle back to the start after `playerCount` rounds, so whenever
 * playerCount doesn't evenly divide roundCap, some positions structurally get
 * more/less late-turn exposure than others over the course of a single game -- 3p, 6p
 * divide evenly (spread 0); 4p/5p/7p have a small residual spread that no shift value
 * can remove (roundCap isn't a multiple of playerCount and never will be for a partial
 * cycle); 8p has the largest residual (measured via the AI Arena tool: position 8 at
 * ~20% win rate vs an ~12.5% baseline, position 6 lowest), and is the one case where
 * changing the shift measurably helps -- shift=3 cuts the modeled exposure spread from
 * 12 to 8 (roughly a third), and stays clear of the shift=(playerCount-1) collision
 * that would reintroduce a back-to-back turn. This is a silent tuning knob, not
 * something surfaced to players -- unlike the 1-seat rotation itself (documented in
 * InstructionsModal), the exact shift amount isn't something a player needs to know to
 * play well.
 */
export function roundRotationShiftFor(playerCount: number): number {
  if (playerCount < 3) return 0;
  return playerCount === 8 ? 3 : 1;
}

function advanceTurn(state: GameState, rng: Rng, computeVote: ComputeVoteFn = computeAiVote): GameState {
  const turnsThisRound = state.turnsThisRound + 1;
  const isRoundBoundary = turnsThisRound >= state.players.length;
  const roundRotationShift = isRoundBoundary ? roundRotationShiftFor(state.players.length) : 0;
  const nextIndex = (state.currentPlayerIndex + 1 + roundRotationShift) % state.players.length;

  if (!isRoundBoundary) {
    const nextState = { ...state, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false, turnsThisRound };
    return { ...nextState, ...redrawOfferForCurrentPlayer(nextState, rng) };
  }

  const completedRound = state.round;

  if (shouldEndGame(state.board, state.config.boardBounds, completedRound, state.config.roundCap)) {
    const playerIds = state.players.map((p) => p.id);
    const result = computeGameResult(state.board, state.config.boardBounds, completedRound, playerIds, state.config.centerEffect);
    return { ...state, phase: "ended", result, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false, turnsThisRound: 0 };
  }

  if (completedRound >= state.config.minRoundFloor) {
    // AI votes resolve immediately (no async input needed); human vote(s) stay
    // pending in `votes` until cast via a castVote action.
    const votes: Record<string, boolean> = {};
    for (const player of state.players) {
      if (player.isAI) votes[player.id] = computeVote(state, player.id, rng);
    }
    const withVotes = { ...state, phase: "voting" as const, votes, currentPlayerIndex: nextIndex, hasFlippedThisTurn: false, turnsThisRound: 0 };
    // Every player might already be AI (e.g. a Jackbox-style display room where no
    // human ever took a seat) -- then the loop above just filled every vote, and
    // there's no castVote action left for anyone to dispatch to trigger the tally.
    // Tally right here in that case instead of sitting in "voting" with a complete
    // ballot nobody ever counts.
    return Object.keys(votes).length === state.players.length ? tallyVotes(withVotes, rng) : withVotes;
  }

  const nextRound = completedRound + 1;
  const roundStart = applyRoundStart(state, nextRound, rng);
  const nextState = { ...state, ...roundStart, currentPlayerIndex: nextIndex, round: nextRound, hasFlippedThisTurn: false, turnsThisRound: 0 };
  return { ...nextState, ...redrawOfferForCurrentPlayer(nextState, rng) };
}

/**
 * Tallies a `state.votes` that's already complete (every player has a ballot in it) --
 * called both once a human's castVote action fills the last slot, and directly from
 * advanceTurn when a round with no human players at all fills every vote by itself
 * (see its call site's comment). Tie -> continue (ending is the disruptive action,
 * needs a real majority) -- at 2p this means consensus.
 */
function tallyVotes(state: GameState, rng: Rng): GameState {
  const votes = state.votes;
  const yesCount = Object.values(votes).filter(Boolean).length;
  const passes = yesCount > state.players.length / 2;
  // Every completed round's tally gets logged here, whether it ended the game or not
  // -- `votes` itself only ever holds the current round's, since it resets to {} below
  // once a "continue" result opens the next round.
  const voteHistory = [...state.voteHistory, { round: state.round, votes }];

  if (passes) {
    const playerIds = state.players.map((p) => p.id);
    const result = computeGameResult(state.board, state.config.boardBounds, state.round, playerIds, state.config.centerEffect);
    return { ...state, phase: "ended", result, votes, voteHistory };
  }

  // currentPlayerIndex is left as-is -- advanceTurn already set it to the correct next
  // player (turn order rotates continuously, it doesn't reset to 0 each round). This is
  // the *default* path into a new round (minRoundFloor is 3 by default), so it needs
  // the same onRoundStart check as advanceTurn's plain continue-branch.
  const nextRound = state.round + 1;
  const roundStart = applyRoundStart(state, nextRound, rng);
  const nextState = { ...state, ...roundStart, phase: "playing" as const, votes: {}, voteHistory, round: nextRound, hasFlippedThisTurn: false };
  return { ...nextState, ...redrawOfferForCurrentPlayer(nextState, rng) };
}

/**
 * Simultaneous private commit, tally when everyone's voted. Tie -> continue (ending
 * is the disruptive action, needs a real majority) -- at 2p this means consensus.
 */
function applyCastVote(state: GameState, action: CastVoteAction, rng: Rng): GameState {
  if (state.phase !== "voting") throw new Error("No vote is currently in progress");
  if (!state.players.some((p) => p.id === action.playerId)) throw new Error(`Unknown player ${action.playerId}`);
  if (action.playerId in state.votes) throw new Error(`${action.playerId} has already voted`);

  const votes = { ...state.votes, [action.playerId]: action.vote };
  if (Object.keys(votes).length < state.players.length) {
    return { ...state, votes };
  }

  return tallyVotes({ ...state, votes }, rng);
}

/**
 * Pure reducer: applyAction(state, action) -> state. Throws on illegal actions.
 * `computeVote` is an optional override for how a round-boundary auto-fills AI seats'
 * votes -- see ComputeVoteFn's own doc comment; every call site that omits it (which
 * is most of them) gets the plain computeAiVote, unchanged from before this existed.
 */
export function applyAction(state: GameState, action: GameAction, rng: Rng = Math.random, computeVote: ComputeVoteFn = computeAiVote): GameState {
  if (state.phase === "ended") throw new Error("Game has already ended");

  // Voting isn't tied to turn order -- any player who hasn't voted yet may cast one,
  // independent of whose turn it currently is.
  if (action.type === "castVote") return applyCastVote(state, action, rng);

  if (state.phase !== "playing") throw new Error("A vote is in progress");
  if (action.playerId !== currentPlayerId(state)) throw new Error(`It is not ${action.playerId}'s turn`);

  switch (action.type) {
    case "flip":
      return applyFlip(state, action);
    case "place":
      return advanceTurn(applyPlace(state, action), rng, computeVote);
    case "pass":
      return advanceTurn(applyPass(state, action.playerId), rng, computeVote);
    default:
      throw new Error(`Unknown action type: ${(action as GameAction).type}`);
  }
}

export { mustPass };
