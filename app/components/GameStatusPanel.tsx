"use client";

import { useState } from "react";
import { FixedTooltip } from "@/app/components/CardCatalog";
import { clearActiveTooltip, setActiveTooltip, toggleActiveTooltip, useActiveTooltipId } from "@/app/hooks/activeTooltip";
import { useHasHover } from "@/app/hooks/useHasHover";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectDescription } from "@/lib/content/centerEffects";
import { PLAYER_TEXT_COLOR_CLASSES, playerDotColorClass } from "@/lib/config/players";
import { estimatedResolutionFor } from "@/lib/engine/endgame";
import { roundRotationShiftFor } from "@/lib/engine/game";
import { currentPlayerId } from "@/lib/engine/turns";
import { GameState } from "@/lib/engine/types";
import { BreakdownPopup } from "./scoreBreakdown";

/** Index-based, not identity-based -- same as Board.tsx's ownerColorClass, just the text-color palette. */
function ownerTextColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_TEXT_COLOR_CLASSES[idx] ?? "text-zinc-500";
}

function RoundBadge({ round, roundCap }: { round: number; roundCap: number }) {
  return (
    <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-full border-2 border-zinc-400 dark:border-zinc-600">
      <span className="text-base leading-none font-bold">{round}</span>
      <span className="text-[9px] leading-none text-zinc-500">of {roundCap}</span>
    </div>
  );
}

/**
 * Label on top, its value in a boxed cell underneath -- `number` renders a compact
 * square cell (e.g. the round something unlocks/opens on), `text` renders a pill for
 * values that aren't a round number (e.g. "now").
 */
function StatusCell({ label, active, number, text }: { label: string; active: boolean; number?: number; text?: string }) {
  const toneClass = active
    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
    : "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400";

  return (
    <div className="flex w-full flex-col items-center gap-1">
      <span
        className={`text-[10px] font-semibold tracking-wide uppercase ${
          active ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"
        }`}
      >
        {label}
      </span>
      {number !== undefined ? (
        <span className={`flex h-8 w-8 items-center justify-center rounded-md border-2 text-sm font-bold ${toneClass}`}>{number}</span>
      ) : (
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-medium ${toneClass}`}>{text}</span>
      )}
    </div>
  );
}

/** "E" voted to end, "C" voted to continue, nothing if they haven't voted this round (or voting hasn't opened yet). Letters, not a check/X -- self-explanatory without a legend, unlike a bare check/X which reads as ambiguously "good"/"bad" rather than "end"/"continue". Green ("go"/keep playing) on C, red (stop) on E -- not the reverse. */
function VoteGlyph({ vote }: { vote: boolean | undefined }) {
  if (vote === undefined) return null;
  return vote ? (
    <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400" title="Voted to end the game">
      E
    </span>
  ) : (
    <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400" title="Voted to keep playing">
      C
    </span>
  );
}

/**
 * "How many points do I have right now" using only what the viewer could actually
 * know -- see estimatedResolutionFor's doc comment for why this is a live, provisional
 * number, not something that only goes up: because effects are neighbor-dependent, a
 * card's contribution can (and will) shift as more of the board fills in around it,
 * including on turns the viewer didn't take. Hovering (or tapping, on touch) shows the
 * same per-card breakdown language EndScreen uses at game end, scoped to just the
 * viewer's own placed cards, so "why is my score X" is never a mystery mid-game either.
 */
function MyScoreTracker({ state, viewerId }: { state: GameState; viewerId: string }) {
  const hasHover = useHasHover();
  const activeTooltipId = useActiveTooltipId();
  const [activeRect, setActiveRect] = useState<DOMRect | null>(null);
  const tooltipId = "myscore";

  const { cards, totalsByOwner } = estimatedResolutionFor(state, viewerId);
  const myScore = totalsByOwner[viewerId] ?? 0;
  const myCards = cards.filter((c) => c.ownerId === viewerId);

  return (
    <div
      className="relative flex w-full cursor-help flex-col items-center gap-0.5 text-center"
      // Same hover-vs-tap split and shared-store wiring as TurnOrderTracker's rows --
      // see activeTooltip.ts's doc comment for why this needs to be a shared store,
      // not local state.
      onMouseEnter={
        hasHover
          ? (e) => {
              setActiveRect(e.currentTarget.getBoundingClientRect());
              setActiveTooltip(tooltipId);
            }
          : undefined
      }
      onMouseLeave={hasHover ? () => clearActiveTooltip(tooltipId) : undefined}
      onClick={
        hasHover
          ? undefined
          : (e) => {
              e.stopPropagation();
              setActiveRect(e.currentTarget.getBoundingClientRect());
              toggleActiveTooltip(tooltipId);
            }
      }
    >
      <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Your score (est.)</span>
      <span className="text-2xl leading-none font-bold text-zinc-900 dark:text-zinc-100">{myScore}</span>
      {activeTooltipId === tooltipId && activeRect && (
        <FixedTooltip rect={activeRect} placement="below">
          <div className="flex flex-col gap-1.5">
            {myCards.length === 0 ? (
              <span className="whitespace-nowrap">No cards placed yet.</span>
            ) : (
              myCards.map((c) => (
                <div key={c.instanceId} className="min-w-[9rem]">
                  <div className="mb-0.5 font-semibold">{CARD_DEFS[c.cardId].name}</div>
                  <div className="pl-2">
                    <BreakdownPopup breakdown={c.breakdown} finalValue={c.finalValue} />
                  </div>
                </div>
              ))
            )}
            <div className="mt-0.5 flex justify-between gap-3 border-t border-white/20 pt-1 font-semibold whitespace-nowrap dark:border-black/20">
              <span>Total</span>
              <span>{myScore}</span>
            </div>
          </div>
        </FixedTooltip>
      )}
    </div>
  );
}

/**
 * Full player roster in seat/turn order, with whoever's turn it currently is visually
 * highlighted -- unlike TurnChecklist ("Your turn" / "Waiting"), this names every
 * player so waiting on someone else actually says *who*. Always visible (not
 * collapsible) since this is the at-a-glance answer to "whose turn is it," not a
 * detail you'd want to dig for.
 *
 * Folds in what used to be a separate "Opponent activity" section: a vote glyph sits
 * right on each row for an instant read, and hovering (or tapping, on touch --
 * see useHasHover) a row surfaces the same flip-history/vote detail that section used
 * to show, via the same portal-based FixedTooltip CardCatalog's card rows use. Both
 * are drawn from state *history* (`flipHistory`/`voteHistory`), not the live
 * board/in-progress votes, so nothing leaks that a player wouldn't otherwise already
 * know -- see the original section's doc comment (removed here) for that reasoning.
 */
function TurnOrderTracker({ state, viewerId, nameFor }: { state: GameState; viewerId: string; nameFor: (id: string) => string }) {
  const activeId = currentPlayerId(state);
  const hasHover = useHasHover();
  // Only one tooltip is ever open anywhere in the app at once (see activeTooltip.ts),
  // so a single locally-held rect is enough -- see CardCatalog's own activeRect for
  // the same reasoning.
  const activeTooltipId = useActiveTooltipId();
  const [activeRect, setActiveRect] = useState<DOMRect | null>(null);
  const lastVoteRound = state.voteHistory[state.voteHistory.length - 1];
  const playerCount = state.players.length;
  // Who this round started with -- a pure derivation from fields already on
  // GameState, valid even mid-round (the only seat skip happens *between* rounds,
  // never within one -- see advanceTurn's roundRotationShift). Only shown for 3+
  // players: that's the only case where it can ever differ from the previous round's,
  // since 2p never rotates. Without this caption, a player mentally tracking "next row
  // down" in the list below would be off by one seat right after a round rolls over,
  // since that's exactly when a seat gets skipped.
  const roundStartIndex = ((state.currentPlayerIndex - state.turnsThisRound) % playerCount + playerCount) % playerCount;
  const roundStartId = state.players[roundStartIndex].id;
  // Same seat-skip math advanceTurn itself applies at a round boundary (see
  // roundRotationShiftFor's doc comment in game.ts) -- derived here, not read off
  // state, since nothing on GameState names "next round's start seat" directly.
  const nextRoundStartIndex = (roundStartIndex + roundRotationShiftFor(playerCount)) % playerCount;
  const nextRoundStartId = state.players[nextRoundStartIndex].id;

  return (
    <div className="flex w-full flex-col gap-1">
      <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Turn order</span>
      {playerCount >= 3 && (
        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
          Round starts with <span className={`font-semibold ${ownerTextColorClass(state, roundStartId)}`}>{nameFor(roundStartId)}</span>
          {roundStartId === viewerId ? " (you)" : ""}
        </span>
      )}
      {playerCount >= 3 && (
        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
          Next round starts with{" "}
          <span className={`font-semibold ${ownerTextColorClass(state, nextRoundStartId)}`}>{nameFor(nextRoundStartId)}</span>
          {nextRoundStartId === viewerId ? " (you)" : ""}
        </span>
      )}
      <div className="flex flex-col gap-0.5">
        {state.players.map((p) => {
          const active = p.id === activeId;
          const vote = lastVoteRound?.votes[p.id];
          const flips = state.flipHistory.filter((f) => f.playerId === p.id);
          const tooltipId = `turnorder:${p.id}`;
          return (
            <div
              key={p.id}
              className={`relative flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs ${
                active
                  ? "border-emerald-500 bg-emerald-50 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : "border-transparent text-zinc-600 dark:text-zinc-400"
              }`}
              // setActiveTooltip/toggleActiveTooltip (not local state) -- see
              // activeTooltip.ts's doc comment for why "only one tooltip open
              // anywhere in the app" needs to be a shared store, not per-component.
              onMouseEnter={
                hasHover
                  ? (e) => {
                      setActiveRect(e.currentTarget.getBoundingClientRect());
                      setActiveTooltip(tooltipId);
                    }
                  : undefined
              }
              onMouseLeave={hasHover ? () => clearActiveTooltip(tooltipId) : undefined}
              onClick={
                hasHover
                  ? undefined
                  : (e) => {
                      e.stopPropagation();
                      setActiveRect(e.currentTarget.getBoundingClientRect());
                      toggleActiveTooltip(tooltipId);
                    }
              }
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${playerDotColorClass(state.players, p.id)}`} />
              <span className="min-w-0 flex-1 truncate">
                {nameFor(p.id)}
                {p.id === viewerId ? " (You)" : ""}
              </span>
              <VoteGlyph vote={vote} />
              {activeTooltipId === tooltipId && activeRect && (
                <FixedTooltip rect={activeRect} placement="below">
                  <div className="flex flex-col gap-1 whitespace-nowrap">
                    <span className={`font-semibold ${ownerTextColorClass(state, p.id)}`}>
                      {nameFor(p.id)}
                      {p.id === viewerId ? " (You)" : ""}
                    </span>
                    <span>
                      Flipped:{" "}
                      {flips.length === 0
                        ? "none yet"
                        : flips.map((f, i) => (
                            // Colored by the flipped card's owner, not the flipper --
                            // a player can blind-flip an opponent's face-down card
                            // too, so this is what tells you whose card got revealed.
                            <span key={f.instanceId}>
                              {i > 0 && ", "}
                              <span className={ownerTextColorClass(state, f.ownerId)}>{CARD_DEFS[f.cardId].name}</span>
                            </span>
                          ))}
                    </span>
                    <span>Last vote: {vote === undefined ? "none yet" : `${vote ? "end" : "continue"} (round ${lastVoteRound!.round})`}</span>
                  </div>
                </FixedTooltip>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact status readout for the header: round, flip/vote availability, center effect, and the turn order. */
export function GameStatusPanel({
  state,
  viewerId,
  nameFor,
  flipUnlocked,
  onCopyState,
  copyFeedback,
}: {
  state: GameState;
  /** Whose panel this is -- the score tracker and turn-order "(You)" tag are both relative to this. */
  viewerId: string;
  nameFor: (id: string) => string;
  flipUnlocked: boolean;
  /** Single-player only feature (the board-state markdown dump) -- omitted entirely (button hidden) when not provided, e.g. in multiplayer. */
  onCopyState?: () => void;
  copyFeedback?: boolean;
}) {
  // Flip: label + either a round number (when there's a specific round to wait for)
  // or a text pill (already-resolved states with no single round to point at).
  let flipLabel: string;
  let flipNumber: number | undefined;
  let flipText: string | undefined;
  if (flipUnlocked) {
    flipLabel = "Flip unlocked";
    flipText = "now";
  } else {
    flipLabel = "Flip unlocks";
    flipNumber = state.config.flipUnlockRound;
  }

  const votingOpen = state.round >= state.config.minRoundFloor;
  const voteLabel = votingOpen ? "Voting open" : "Voting opens";

  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-8 lg:w-40 lg:self-start">
      <div className="flex flex-col items-center gap-4 rounded-xl border border-zinc-300 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
        <RoundBadge round={state.round} roundCap={state.config.roundCap} />
        {(state.phase === "playing" || state.phase === "voting") && state.players.some((p) => p.id === viewerId) && (
          <>
            <MyScoreTracker state={state} viewerId={viewerId} />
            <div className="h-px w-full shrink-0 bg-zinc-300 dark:bg-zinc-700" />
          </>
        )}
        <div className="flex w-full flex-col gap-3">
          <StatusCell label={flipLabel} active={flipUnlocked} number={flipNumber} text={flipText} />
          <StatusCell
            label={voteLabel}
            active={votingOpen}
            number={votingOpen ? undefined : state.config.minRoundFloor}
            text={votingOpen ? "now" : undefined}
          />
        </div>
        <div className="flex w-full flex-col items-center gap-1 text-center">
          <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Center</span>
          <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">{CENTER_EFFECTS[state.config.centerEffect].label}</span>
          <span className="text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
            {centerEffectDescription(state.config.centerEffect, state.config)}
          </span>
        </div>
        {state.phase === "playing" && (
          <>
            <div className="h-px w-full shrink-0 bg-zinc-300 dark:bg-zinc-700" />
            <TurnOrderTracker state={state} viewerId={viewerId} nameFor={nameFor} />
          </>
        )}
        {onCopyState && (
          <>
            <div className="h-px w-full shrink-0 bg-zinc-300 dark:bg-zinc-700" />
            <button
              onClick={onCopyState}
              className="w-full rounded-full border border-zinc-300 px-3 py-1.5 text-xs whitespace-nowrap hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {copyFeedback ? "Copied!" : "Copy board state"}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
