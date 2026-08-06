"use client";

import { useState } from "react";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectDescription } from "@/lib/content/centerEffects";
import { PLAYER_TEXT_COLOR_CLASSES } from "@/lib/config/players";
import { GameState } from "@/lib/engine/types";

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

function ChecklistItem({ done, disabled, label }: { done: boolean; disabled?: boolean; label: string }) {
  return (
    <div
      className={`flex items-start gap-1.5 text-xs ${
        disabled ? "text-zinc-400 line-through dark:text-zinc-600" : done ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-700 dark:text-zinc-300"
      }`}
    >
      <span>{done ? "☑" : "☐"}</span>
      {label}
    </div>
  );
}

/** Live checklist for the viewer's current turn -- ticks off the optional flip as soon as it's used. */
function TurnChecklist({
  isMyTurn,
  hasFlippedThisTurn,
  flipUnlocked,
  mustPass,
}: {
  isMyTurn: boolean;
  hasFlippedThisTurn: boolean;
  flipUnlocked: boolean;
  mustPass: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        {isMyTurn ? "Your turn" : "Waiting"}
      </span>
      <ChecklistItem done={hasFlippedThisTurn} disabled={!isMyTurn || !flipUnlocked} label="Flip a card (optional)" />
      <ChecklistItem done={false} disabled={!isMyTurn} label={mustPass ? "Pass (no legal move)" : "Place a card"} />
    </div>
  );
}

/**
 * Per-opponent summary of what they've revealed and how they voted last -- both drawn
 * from state history rather than the live board/votes, so it can't leak anything a
 * player wouldn't otherwise already know: `flipHistory` entries are only ever cards
 * that already got flipped face-up (already public the moment it happened), and only
 * the *last completed* voting round is shown (`voteHistory`), never the in-progress
 * `votes` -- those stay private until everyone's voted, per the locked-vote protocol.
 * Collapsed by default, same reasoning as CardCatalog's Locations section -- useful
 * reference, not something that needs to eat vertical space on every turn.
 */
function OpponentActivityPanel({ state, viewerId, nameFor }: { state: GameState; viewerId: string; nameFor: (id: string) => string }) {
  const [collapsed, setCollapsed] = useState(true);
  const opponents = state.players.filter((p) => p.id !== viewerId);
  if (opponents.length === 0) return null;

  const lastVoteRound = state.voteHistory[state.voteHistory.length - 1];

  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <button
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center justify-center gap-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <span className="inline-block w-3 shrink-0">{collapsed ? "▶" : "▼"}</span>
        Opponent activity
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-3">
          {opponents.map((p) => {
            const flips = state.flipHistory.filter((f) => f.playerId === p.id);
            const vote = lastVoteRound?.votes[p.id];
            return (
              <div key={p.id} className="flex flex-col gap-0.5">
                <span className={`text-xs font-semibold ${ownerTextColorClass(state, p.id)}`}>{nameFor(p.id)}</span>
                <span className="text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                  Flipped:{" "}
                  {flips.length === 0
                    ? "none yet"
                    : flips.map((f, i) => (
                        // Colored by the flipped card's owner, not the flipper -- a
                        // player can blind-flip an opponent's face-down card too, so
                        // this is what actually tells you whose card got revealed.
                        <span key={f.instanceId}>
                          {i > 0 && ", "}
                          <span className={ownerTextColorClass(state, f.ownerId)}>{CARD_DEFS[f.cardId].name}</span>
                        </span>
                      ))}
                </span>
                <span className="text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                  Last vote: {vote === undefined ? "none yet" : `${vote ? "end" : "continue"} (round ${lastVoteRound!.round})`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Compact status readout for the header: round, flip/vote availability, center effect, and the turn checklist. */
export function GameStatusPanel({
  state,
  viewerId,
  nameFor,
  flipUnlocked,
  isMyTurn,
  myMustPass,
  onCopyState,
  copyFeedback,
}: {
  state: GameState;
  /** Whose panel this is -- "opponent activity" excludes this id, and the turn checklist is framed relative to it. */
  viewerId: string;
  nameFor: (id: string) => string;
  flipUnlocked: boolean;
  isMyTurn: boolean;
  myMustPass: boolean;
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
            <TurnChecklist isMyTurn={isMyTurn} hasFlippedThisTurn={state.hasFlippedThisTurn} flipUnlocked={flipUnlocked} mustPass={myMustPass} />
          </>
        )}
        <div className="h-px w-full shrink-0 bg-zinc-300 dark:bg-zinc-700" />
        <div className="w-full overflow-x-hidden lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <OpponentActivityPanel state={state} viewerId={viewerId} nameFor={nameFor} />
        </div>
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
