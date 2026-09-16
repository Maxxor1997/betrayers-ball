"use client";

import { useEffect, useRef, useState } from "react";
import { colorIndexFor, PLAYER_DOT_COLOR_CLASSES, PLAYER_TEXT_COLOR_CLASSES } from "@/lib/config/players";
import { computeStandardRanking, ordinal } from "@/lib/engine/endgame";
import { currentPlayerId } from "@/lib/engine/turns";
import { GameState } from "@/lib/engine/types";
import { SOUNDS } from "@/lib/audio/sounds";
import { playSound } from "@/lib/audio/soundManager";
import { setRoundEndOverlayActive } from "@/app/hooks/roundEndOverlayActive";

const FLIP_STAGGER_MS = 600;
/**
 * How long after a vote tile's `revealed` prop flips true before its sound plays --
 * the tile's own flip is a 500ms rotateY animation (see globals.css's
 * card-flip-reveal), so playing the sound the instant `revealed` becomes true (at the
 * very start of that animation, card still edge-on) lands noticeably before the tile
 * visually shows its result. This roughly matches the point the rotation crosses
 * 90deg and the result face becomes visible, so the sound lands with the reveal
 * instead of the wind-up.
 */
const VOTE_FLIP_SOUND_DELAY_MS = 260;
const BANNER_HOLD_CONTINUE_MS = 2000;
const BANNER_HOLD_ENDED_MS = 1600;
const SCORE_COUNT_MS = 2600;
const SCORE_SETTLE_PAUSE_MS = 900;

type Stage = "idle" | "votes" | "banner" | "score" | "ranking";

interface RoundEvent {
  ended: boolean;
  completedRound: number;
  nextRound: number;
  votes: Record<string, boolean> | null;
  players: string[];
  /** Who goes first in `nextRound` -- null when `ended`, nothing left to lead. */
  roundLeaderId: string | null;
}

/** easeOutCubic -- fast start, gentle landing on the final number, reads better than a linear count for "settling" on a score. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Fires on every round boundary -- state.round advancing, or phase flipping to
 * "ended" -- not just the ones with a real vote to show. Every outcome used to be
 * silent: a voted tally (`tallyVotes`, game.ts) flips phase in one instant engine
 * step with individual votes genuinely hidden from every player until that exact
 * moment (see playerView.ts stripping everyone else's vote while phase is "voting"),
 * but a round can *also* end a boundary with no vote at all -- every round before
 * minRoundFloor advances silently, and the game can end outright the instant
 * roundCap is hit, no voting phase ever opening (both in advanceTurn, game.ts). This
 * shows a reveal for all of them: the vote-by-vote stage plays only when
 * voteHistory actually has an entry for that boundary; otherwise it goes straight to
 * the round/game banner.
 *
 * Everything shown here is already fully computed by the time it's shown (the whole
 * tally, and if the game ended, the final scores) -- this is a pure client-side
 * staged reveal of already-known data, not a new engine mechanic. Mount this once,
 * unconditionally, alongside the board on any page that plays a real game
 * (/play, /join/[code], /host/[code]) -- it watches `state.round`/`state.phase`
 * itself via refs and self-triggers, so there's nothing else for a caller to wire
 * up. A click/tap anywhere skips straight to that outcome's resolved end state.
 *
 * Deliberately doesn't touch EndScreen -- once the ended-path's ranking stage is
 * dismissed, EndScreen (already conditionally mounted by the caller whenever
 * `state.phase === "ended"`) is sitting right underneath, for full per-card detail.
 */
export function RoundEndOverlay({ state, viewerId, nameFor }: { state: GameState; viewerId: string; nameFor: (id: string) => string }) {
  // Tracks round-boundary crossings directly (state.round increasing, or phase
  // flipping to "ended") rather than just voteHistory growing -- a round can end
  // WITHOUT any vote at all, two different ways: every round before minRoundFloor
  // advances silently (see advanceTurn's plain "nextRound = completedRound + 1"
  // branch, game.ts), and the game can end outright the instant roundCap is hit
  // (advanceTurn's shouldEndGame branch) with no voting phase ever opening. Both are
  // exactly the "not clear when the game ended or continued" gap this overlay
  // exists to close, not just the voted case. voteHistory is still consulted below,
  // just to look up whether THIS particular boundary happens to have real vote data
  // to reveal -- when it doesn't, the vote-reveal stage is skipped and this goes
  // straight to the round/game banner.
  //
  // Boundaries queue rather than overwrite whatever's currently showing: two
  // boundaries can land in the same React batch (e.g. a fast AI-only round with no
  // human turn to pace it against a render), and without a queue the second one's
  // setRound/setStage would simply clobber the first's before it ever painted --
  // exactly a "the reveal sometimes doesn't show" symptom, worse the fewer human
  // turns happen to fall in a round (so more turn-order-dependent than it looks).
  // `stageRef` mirrors `stage` synchronously (React state itself only updates on
  // the next render) so the queue can be checked immediately, in the same tick a
  // sequence finishes, with no risk of reading a stale value.
  const prevRoundRef = useRef(state.round);
  const endHandledRef = useRef(state.phase === "ended");
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef<number | null>(null);
  const queueRef = useRef<RoundEvent[]>([]);
  const stageRef = useRef<Stage>("idle");

  const [stage, setStageState] = useState<Stage>("idle");
  const [round, setRound] = useState<RoundEvent | null>(null);
  const [revealedCount, setRevealedCount] = useState(0);
  const [displayedScores, setDisplayedScores] = useState<Record<string, number>>({});
  // Drives the round-number tile's own flip (completedRound -> nextRound), shown for
  // a vote-less continue -- there's no vote-by-vote reveal to build tension, so the
  // round number itself flipping is the one piece of drama available.
  const [roundFlipped, setRoundFlipped] = useState(false);

  const setStage = (next: Stage) => {
    stageRef.current = next;
    setStageState(next);
  };

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  useEffect(() => clearTimers, []);

  // Lets a page's own AI-turn driver (currently just /play's) pause while this is
  // showing -- see roundEndOverlayActive.ts's own doc comment for why. Two separate
  // effects rather than one with a cleanup: a single effect's cleanup fires between
  // every re-invocation, not just on unmount, which would flip this false-then-true
  // on every stage change instead of just tracking it directly.
  useEffect(() => {
    setRoundEndOverlayActive(stage !== "idle");
  }, [stage]);

  // Defensive only (no page unmounts this mid-reveal today) -- resets the flag on a
  // genuine unmount so it can never get stuck true forever.
  useEffect(() => {
    return () => setRoundEndOverlayActive(false);
  }, []);

  const startEvent = (event: RoundEvent) => {
    clearTimers();
    setRound(event);
    setRevealedCount(0);
    setDisplayedScores({});
    setRoundFlipped(false);
    setStage(event.votes ? "votes" : "banner");
  };

  /** Called any time a sequence reaches "idle" -- picks up the next queued boundary immediately, if any, so a burst of transitions plays out one after another instead of ever flashing the board in between. */
  const advanceQueue = () => {
    const next = queueRef.current.shift();
    if (next) startEvent(next);
  };

  const dismiss = () => {
    setStage("idle");
    advanceQueue();
  };

  // Never replays a boundary already crossed before this component mounted (a page
  // reload/rejoin mid-game shouldn't dramatically re-show every past round).
  useEffect(() => {
    // A new game started -- Continue/rematch/New Game all deal a fresh GameState
    // (round reset to 1) into this SAME mounted component, so prevRoundRef/
    // endHandledRef are still holding the PREVIOUS game's final round/ended state.
    // Without this resync, the overlay silently never fires for the whole next
    // game: e.g. prevRoundRef stuck at a prior game's round 4 makes "round 1 > 4"
    // false for every boundary until (if ever) the new game's round number happens
    // to exceed 4, and endHandledRef stuck true makes a genuine new ending look
    // "already handled." A real game's round only ever counts up, so seeing it go
    // backward is an unambiguous "this is a new game" signal -- resync silently
    // here (nothing to reveal about a game just starting) rather than firing an
    // event for it.
    if (state.round < prevRoundRef.current) {
      prevRoundRef.current = state.round;
      endHandledRef.current = state.phase === "ended";
      return;
    }

    const isEndedNow = state.phase === "ended";
    const roundAdvanced = state.round > prevRoundRef.current;
    const justEnded = isEndedNow && !endHandledRef.current;
    if (!roundAdvanced && !justEnded) return;

    const completedRound = justEnded ? state.round : prevRoundRef.current;
    const nextRound = state.round;
    const voteEntry = state.voteHistory.find((h) => h.round === completedRound);

    prevRoundRef.current = state.round;
    if (isEndedNow) endHandledRef.current = true;

    const event: RoundEvent = {
      ended: isEndedNow,
      completedRound,
      nextRound,
      votes: voteEntry?.votes ?? null,
      players: state.players.map((p) => p.id),
      roundLeaderId: isEndedNow ? null : currentPlayerId(state),
    };

    if (stageRef.current === "idle") {
      startEvent(event);
    } else {
      queueRef.current.push(event);
    }
  }, [state.round, state.phase, state.voteHistory, state.players]);

  // The round-flip tile's own animation: start showing completedRound, flip to
  // nextRound a beat later -- plays for every continuing boundary, voted or not
  // (see the JSX below), for one consistent "round is changing" visual either way.
  useEffect(() => {
    if (stage !== "banner" || !round || round.ended) return;
    const t = setTimeout(() => {
      setRoundFlipped(true);
      playSound(SOUNDS.roundFlip, 0.6);
    }, 500);
    timersRef.current.push(t);
  }, [stage, round]);

  // The game-over banner's own one-shot sting -- fires exactly once per ended event
  // (round changes identity every event, even across a queued burst -- see the
  // queueing comment above), regardless of whether it arrived via a vote or forced
  // roundCap end.
  useEffect(() => {
    if (stage === "banner" && round?.ended) playSound(SOUNDS.gameOver);
  }, [stage, round]);

  // Drives the vote-by-vote reveal, then hands off to the banner stage. Only ever
  // reached when this boundary actually had votes (see stage's initial value above).
  useEffect(() => {
    if (stage !== "votes" || !round) return;
    if (revealedCount > 0) {
      const soundTimer = setTimeout(() => playSound(SOUNDS.vote, 0.5), VOTE_FLIP_SOUND_DELAY_MS);
      timersRef.current.push(soundTimer);
    }
    if (revealedCount >= round.players.length) {
      const t = setTimeout(() => setStage("banner"), 500);
      timersRef.current.push(t);
      return;
    }
    const t = setTimeout(() => setRevealedCount((c) => c + 1), revealedCount === 0 ? 300 : FLIP_STAGGER_MS);
    timersRef.current.push(t);
  }, [stage, round, revealedCount]);

  // Banner stage -> continuing dismisses itself; ended chains into the score reveal.
  useEffect(() => {
    if (stage !== "banner" || !round) return;
    if (!round.ended) {
      const t = setTimeout(() => dismiss(), BANNER_HOLD_CONTINUE_MS);
      timersRef.current.push(t);
      return;
    }
    const t = setTimeout(() => setStage("score"), BANNER_HOLD_ENDED_MS);
    timersRef.current.push(t);
  }, [stage, round]);

  // Score count-up -- every player animates from 0 to their final score concurrently.
  useEffect(() => {
    if (stage !== "score" || !round || !state.result) return;
    const scores = state.result.scores;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / SCORE_COUNT_MS);
      const eased = easeOutCubic(t);
      const next: Record<string, number> = {};
      for (const id of round.players) next[id] = Math.round((scores[id] ?? 0) * eased);
      setDisplayedScores(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        const settle = setTimeout(() => setStage("ranking"), SCORE_SETTLE_PAUSE_MS);
        timersRef.current.push(settle);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [stage, round, state.result]);

  if (stage === "idle" || !round) return null;

  const skip = () => {
    clearTimers();
    if (round.ended) {
      // Already at the final stage -- a click here means "dismiss," not "fast-
      // forward" (nothing left to fast-forward to). Without this, ranking never
      // actually closed: every click just re-set it to "ranking" again, a no-op.
      if (stage === "ranking") {
        dismiss();
        return;
      }
      if (state.result) setDisplayedScores(state.result.scores);
      setRevealedCount(round.players.length);
      setStage("ranking");
      return;
    }
    // Continuing: each stage gets its own single "complete this step" click before
    // the next click moves on -- votes-in-progress reveal fully and hand off to the
    // banner; the round-number tile's own flip completes; only then does a further
    // click dismiss (and let the queue advance, if anything's waiting).
    if (stage === "votes") {
      setRevealedCount(round.players.length);
      setStage("banner");
      return;
    }
    if (!roundFlipped) {
      setRoundFlipped(true);
      playSound(SOUNDS.roundFlip, 0.6);
      return;
    }
    dismiss();
  };

  const votes = round.votes;
  const endCount = votes ? round.players.slice(0, revealedCount).filter((id) => votes[id]).length : 0;
  const continueCount = votes ? round.players.slice(0, revealedCount).filter((id) => !votes[id]).length : 0;

  // A game-ending event's EndScreen is already mounted underneath from the moment
  // this component's very first stage renders (state.phase flips to "ended" in the
  // SAME state update the boundary is detected from -- see the detection effect
  // above), all the way through votes/banner/score/ranking. A translucent/blurred
  // backdrop would let its real final scores and ranking show (and be readable)
  // through the overlay well before the score count-up or vote reveal gets there --
  // spoiling exactly the tension this whole sequence exists to build. Fully opaque
  // for the entire ended sequence; the lighter blurred look is only for a continue,
  // which has nothing sensitive mounted behind it.
  const backdropClass = round.ended ? "bg-zinc-950" : "bg-black/70 backdrop-blur-[2px]";

  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer flex-col items-center justify-center gap-6 px-4 ${backdropClass}`}
      onClick={skip}
      role="button"
      aria-label="Skip round-end reveal"
    >
      {votes && (stage === "votes" || stage === "banner") && (
        <>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {round.players.map((id, i) => (
              <VoteTile key={id} state={state} playerId={id} name={nameFor(id)} isYou={id === viewerId} vote={votes[id]} revealed={i < revealedCount} />
            ))}
          </div>
          <p className="font-mono text-sm text-zinc-300 tabular-nums">
            <span className="text-rose-400">{endCount} to end</span> · <span className="text-emerald-400">{continueCount} to continue</span>
          </p>
        </>
      )}
      {stage === "banner" && !round.ended && (
        <>
          <RoundFlipTile completedRound={round.completedRound} nextRound={round.nextRound} flipped={roundFlipped} />
          {round.roundLeaderId && <RoundLeaderLine name={nameFor(round.roundLeaderId)} isYou={round.roundLeaderId === viewerId} />}
        </>
      )}
      {stage === "banner" && round.ended && <p className="text-3xl font-bold text-amber-400">Game Over</p>}

      {stage === "score" && (
        <div className="flex flex-wrap items-center justify-center gap-5">
          {round.players.map((id) => (
            <ScoreTile key={id} state={state} playerId={id} name={nameFor(id)} isYou={id === viewerId} score={displayedScores[id] ?? 0} />
          ))}
        </div>
      )}

      {stage === "ranking" && state.result && <FinalRankingCard state={state} nameFor={nameFor} viewerId={viewerId} />}

      <p className="text-xs text-zinc-500">Tap anywhere to {stage === "ranking" ? "continue" : "skip"}</p>
    </div>
  );
}

/** Who goes first in the round about to start -- shown under either continue banner (voted or vote-less). */
function RoundLeaderLine({ name, isYou }: { name: string; isYou: boolean }) {
  return (
    <p className="text-sm text-zinc-300">
      {isYou ? <span className="font-semibold text-emerald-400">You</span> : <span className="font-semibold text-zinc-100">{name}</span>} lead
      {isYou ? "" : "s"} next round
    </p>
  );
}

/** A vote-less continue's own reveal: the round number itself flips from completedRound to nextRound -- same 3D flip technique as a board card's own face-down reveal (see globals.css's .card-flip-inner). */
function RoundFlipTile({ completedRound, nextRound, flipped }: { completedRound: number; nextRound: number; flipped: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-xs tracking-wide text-zinc-400 uppercase">Round</span>
      <div className="aspect-square w-20 [perspective:600px]">
        {flipped ? (
          <div className="card-flip-inner">
            <div className="card-flip-face flex items-center justify-center rounded-md border-2 border-zinc-600 bg-zinc-800 text-3xl font-bold text-zinc-300">
              {completedRound}
            </div>
            <div className="card-flip-face card-flip-face-back flex items-center justify-center rounded-md border-2 border-emerald-500 bg-emerald-950 text-3xl font-bold text-emerald-400">
              {nextRound}
            </div>
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded-md border-2 border-zinc-600 bg-zinc-800 text-3xl font-bold text-zinc-300">
            {completedRound}
          </div>
        )}
      </div>
    </div>
  );
}

function VoteTile({
  state,
  playerId,
  name,
  isYou,
  vote,
  revealed,
}: {
  state: GameState;
  playerId: string;
  name: string;
  isYou: boolean;
  vote: boolean;
  revealed: boolean;
}) {
  const idx = colorIndexFor(state.players, playerId);
  const dotClass = PLAYER_DOT_COLOR_CLASSES[idx] ?? "bg-zinc-400";
  return (
    <div className="flex w-16 flex-col items-center gap-1.5">
      <div className="aspect-square w-16 [perspective:600px]">
        {revealed ? (
          <div className="card-flip-inner">
            <div className="card-flip-face flex items-center justify-center rounded-md border-2 border-zinc-600 bg-zinc-800">
              <span className={`h-3 w-3 rounded-full ${dotClass} opacity-60`} />
            </div>
            <div
              className={`card-flip-face card-flip-face-back flex items-center justify-center rounded-md border-2 text-2xl font-bold ${
                vote ? "border-rose-500 bg-rose-950 text-rose-400" : "border-emerald-500 bg-emerald-950 text-emerald-400"
              }`}
            >
              {vote ? "E" : "C"}
            </div>
          </div>
        ) : (
          <div className={`flex h-full w-full items-center justify-center rounded-md border-2 border-zinc-600 bg-zinc-800`}>
            <span className={`h-3 w-3 rounded-full ${dotClass} opacity-60`} />
          </div>
        )}
      </div>
      <span className="max-w-full truncate text-xs text-zinc-300">
        {name}
        {isYou && <span className="text-zinc-500"> (you)</span>}
      </span>
    </div>
  );
}

function ScoreTile({ state, playerId, name, isYou, score }: { state: GameState; playerId: string; name: string; isYou: boolean; score: number }) {
  const idx = colorIndexFor(state.players, playerId);
  const textClass = PLAYER_TEXT_COLOR_CLASSES[idx] ?? "text-zinc-300";
  const isWinner = state.result?.winnerIds.includes(playerId) ?? false;
  const settled = state.result ? score === state.result.scores[playerId] : false;
  return (
    <div
      className={`flex flex-col items-center gap-1 rounded-xl border-2 px-5 py-4 transition-shadow duration-300 ${
        isWinner && settled ? "border-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.5)]" : "border-zinc-700"
      }`}
    >
      <span className="text-xs text-zinc-400">
        {name}
        {isYou && <span> (you)</span>}
      </span>
      <span className={`font-mono text-4xl font-bold tabular-nums ${textClass}`}>{score}</span>
    </div>
  );
}

function FinalRankingCard({ state, nameFor, viewerId }: { state: GameState; nameFor: (id: string) => string; viewerId: string }) {
  const gameResult = state.result!;
  const playerIds = state.players.map((p) => p.id);
  const rankedPlayerIds = [...playerIds].sort((a, b) => gameResult.scores[b] - gameResult.scores[a]);
  const { rankByPlayerId, countAtRank } = computeStandardRanking(playerIds, gameResult.scores);

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-5">
      <h2 className="text-center text-lg font-semibold text-amber-400">Final Ranking</h2>
      <ul className="flex flex-col gap-1.5">
        {rankedPlayerIds.map((id) => {
          const rank = rankByPlayerId.get(id)!;
          const tied = (countAtRank.get(rank) ?? 1) > 1;
          const idx = colorIndexFor(state.players, id);
          const dotClass = PLAYER_DOT_COLOR_CLASSES[idx] ?? "bg-zinc-400";
          const isWinner = rank === 1;
          return (
            <li
              key={id}
              className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                isWinner ? "border-amber-400 bg-amber-950/40" : "border-zinc-700 bg-zinc-800/60"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
                <span className="truncate text-sm text-zinc-200">
                  {nameFor(id)}
                  {id === viewerId && <span className="text-zinc-500"> (you)</span>}
                </span>
              </span>
              <span className="shrink-0 text-xs font-medium text-zinc-400">
                {tied ? "Tied for " : ""}
                {ordinal(rank)} · <span className="font-mono tabular-nums">{gameResult.scores[id]}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
