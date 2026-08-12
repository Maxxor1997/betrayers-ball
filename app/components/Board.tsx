"use client";

import { CardArt } from "@/app/components/CardArt";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectDescription, pseudoCardLiveValue } from "@/lib/content/centerEffects";
import { inBounds, isOwnerlessPosition } from "@/lib/engine/board";
import { PLAYER_COLOR_CLASSES } from "@/lib/config/players";
import { computeNegatedInstanceIds, ResolvedCard } from "@/lib/engine/resolution";
import { GameState, Position, posKey } from "@/lib/engine/types";
import { clearActiveTooltip, setActiveTooltip, toggleActiveTooltip, useActiveTooltipId } from "@/app/hooks/activeTooltip";
import { useHasHover } from "@/app/hooks/useHasHover";
import { visibleBreakdown } from "./scoreBreakdown";

/** Index-based, not identity-based -- same seat position always gets the same color regardless of who (human or AI, single- or multiplayer) sits there. */
function ownerColorClass(state: GameState, ownerId: string): string {
  const idx = state.players.findIndex((p) => p.id === ownerId);
  return PLAYER_COLOR_CLASSES[idx] ?? "border-zinc-400";
}

export interface BoardGridProps {
  state: GameState;
  /** Who's looking -- "You" vs. everyone else, and what a still-hidden card's tooltip says, are both relative to this, not a hardcoded identity. Single-player passes its fixed HUMAN id; a networked client passes whatever playerId the server assigned it. */
  viewerId: string;
  /** Display name for a given ownerId -- caller-supplied so this component doesn't need to know single-player's "You"/AI_NAMES scheme vs. multiplayer's lobby-chosen names. */
  nameFor: (ownerId: string) => string;
  legalCellKeys: Set<string>;
  flipTargetIds: Set<string>;
  selectedInstanceId: string | null;
  dragOverKey: string | null;
  revealAll: boolean;
  /** Scoring breakdown per instanceId, once the game has ended -- see EndScreen. */
  resolvedCards?: Map<string, ResolvedCard>;
  onCellClick: (pos: Position) => void;
  onCellDragOver: (e: React.DragEvent, key: string) => void;
  onCellDragLeave: () => void;
  onCellDrop: (e: React.DragEvent, pos: Position) => void;
}

export function BoardGrid({
  state,
  viewerId,
  nameFor,
  legalCellKeys,
  flipTargetIds,
  selectedInstanceId,
  dragOverKey,
  revealAll,
  resolvedCards,
  onCellClick,
  onCellDragOver,
  onCellDragLeave,
  onCellDrop,
}: BoardGridProps) {
  const { width, height } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);
  const activeTooltipId = useActiveTooltipId();
  const hasHover = useHasHover();
  // EndScreen's per-card breakdown rows share this same tooltip store, namespaced
  // `endscreen:${instanceId}` (see EndScreen.tsx) -- reusing that instead of adding a
  // separate onHover callback/prop means hovering (or tapping, on touch) a row in the
  // end-of-game breakdown highlights that exact card here for free, with the same
  // hover-vs-tap and click/scroll-to-dismiss behavior every other tooltip already has.
  const endScreenPrefix = "endscreen:";
  const hoveredEndCardInstanceId = activeTooltipId?.startsWith(endScreenPrefix) ? activeTooltipId.slice(endScreenPrefix.length) : null;

  // Cells are sized to fill their grid column (aspect-square, no fixed px) rather than
  // a fixed h-20 w-20 -- with wider/taller boards (7-8p can be 11+ columns or rows) a
  // fixed cell size would push the grid past the available width or height. Rows are
  // implicit and auto-sized purely off each cell's own rendered width (aspect-square),
  // so the grid's total footprint is entirely determined by ITS width -- there's no
  // separate row-height constraint to satisfy. That means the whole "fit both
  // dimensions" problem reduces to picking one width, which we compute directly as the
  // smallest of: the available horizontal space (100%), a comfortable 5rem/cell cap,
  // and whatever width keeps the resulting height (at 5rem/cell) within a viewport
  // budget. Setting `width` (not `max-width`) to that precomputed value means there's
  // nothing left for the browser to reflow or overflow -- unlike relying on `aspect-
  // ratio` + `max-height` to shrink an already-definite `width: 100%`, which it won't.
  const CELL_SIZE_PX = 80;
  const GAP_PX = 6;
  const VERTICAL_BUDGET_VH = 90;
  const naturalWidthPx = width * CELL_SIZE_PX + (width - 1) * GAP_PX;
  // `svh` (small viewport height), not `vh` -- `vh` tracks the browser's live visible
  // viewport, which shrinks/grows as mobile browser chrome (address bar) collapses or
  // expands during scrolling/interaction. For a near-square board (8p is ~11x11) this
  // height budget is almost always the binding constraint, so a plain `vh` here meant
  // the board visibly resized mid-game any time the toolbar changed. `svh` always
  // assumes the toolbar is visible (the smallest possible viewport), so it's stable.
  const widthForHeightBudget = `calc(${VERTICAL_BUDGET_VH}svh * ${width / height})`;

  return (
    <div
      className="grid gap-1.5"
      style={{
        gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`,
        width: `min(100%, ${naturalWidthPx}px, ${widthForHeightBudget})`,
      }}
    >
      {rows.map((y) =>
        cols.map((x) => {
          const pos = { x, y };
          if (!inBounds(pos, state.config.boardBounds)) return null;
          const key = posKey(pos);
          const isOwnerless = isOwnerlessPosition(pos, state.config.boardBounds);
          const card = state.board.get(key);
          const isLegal = legalCellKeys.has(key);

          if (isOwnerless) {
            const effect = CENTER_EFFECTS[state.config.centerEffect];
            const label = effect.ownerlessLabel ?? effect.label;
            const detail = centerEffectDescription(state.config.centerEffect, state.config);
            const negated = computeNegatedInstanceIds(state.board, state.config.boardBounds);
            const liveValue = pseudoCardLiveValue(state.config.centerEffect, state.board, state.config.boardBounds, negated);
            const displayLabel = liveValue === null ? label : `${label} (${liveValue})`;
            const tooltipId = `board:${key}`;
            return (
              <div
                key={key}
                className="relative @container"
                // Hover-capable devices get real hover; touch devices get an explicit
                // tap-to-toggle instead -- never both (see useHasHover's doc comment
                // for why mixing them needs two taps on touch to ever show anything).
                // setActiveTooltip/toggleActiveTooltip (not local state) so this
                // shares one "only one tooltip open at a time, anywhere in the app"
                // source of truth with every other tap-to-toggle tooltip -- see
                // activeTooltip.ts's doc comment.
                onMouseEnter={hasHover ? () => setActiveTooltip(tooltipId) : undefined}
                onMouseLeave={hasHover ? () => clearActiveTooltip(tooltipId) : undefined}
                onClick={
                  hasHover
                    ? undefined
                    : (e) => {
                        e.stopPropagation();
                        toggleActiveTooltip(tooltipId);
                      }
                }
              >
                {/* Below the threshold, the label can't fit without wrapping (which,
                    combined with the aspect-square cell, either overflows or looks
                    like a mangled two-line squeeze) -- so it's just a solid tinted
                    block instead, no text. Same idea as the card name's own
                    @container cutoff, just a different fallback since this tile has
                    no icon to fall back to. */}
                <div
                  className={`hidden aspect-square w-full items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400 @[52px]:flex`}
                >
                  {displayLabel}
                </div>
                <div className={`aspect-square w-full rounded-md opacity-60 @[52px]:hidden ${effect.themeColorClass} bg-current`} />
                {activeTooltipId === tooltipId && (
                  <div className="pointer-events-none absolute -top-9 left-1/2 z-10 w-max max-w-[14rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                    {displayLabel} — {detail}
                  </div>
                )}
              </div>
            );
          }

          if (card) {
            const clickable = !card.faceUp && flipTargetIds.has(card.instanceId) && !selectedInstanceId;
            const displayFaceUp = revealAll || card.faceUp;
            // At game end, cards that were face-down during play are shown with faded
            // text instead of a separate badge -- distinguishable without being loud.
            const faded = revealAll && !card.faceUp;
            const def = CARD_DEFS[card.cardId];
            // Hovering a known card (revealed, or your own even if still face-down)
            // shows its short effect text -- same summary as the hand/catalog, not the
            // full rules text, so a mid-game hover stays a quick glance rather than a
            // wall of text. An opponent's still-hidden card shows nothing, so no info
            // leaks before a flip. The hover listener lives on the wrapper div (not the
            // button) so it still fires even when the button itself is disabled.
            const tooltipOwner = nameFor(card.ownerId);
            // A hand card selected (any type) highlights every one of the viewer's own
            // cards on the board, face-up or still face-down -- own identity is always
            // known regardless of face state, and this is the "which cells are mine"
            // aid, not a "where are more of this type" one, so opponents' cards (even
            // an exact type match) are deliberately excluded.
            const highlighted =
              (selectedInstanceId !== null && card.ownerId === viewerId) || card.instanceId === hoveredEndCardInstanceId;
            const tooltipDetail = displayFaceUp
              ? `${def.name} (${def.base}) — ${def.text}`
              : card.ownerId === viewerId
                ? `${def.name} (${def.base}) — ${def.text} — only visible to you`
                : "face-down card";
            // Only once the game has ended does a score breakdown exist -- see Game()'s
            // `resolvedCards`, computed once and shared with EndScreen's summary table.
            const resolvedCard = resolvedCards?.get(card.instanceId);
            const tooltipId = `board:${key}`;
            return (
              <div
                key={key}
                className="relative"
                // Hover-capable devices get real hover; touch devices get an explicit
                // tap-to-toggle instead -- never both (see useHasHover's doc comment
                // for why mixing them needs two taps on touch to ever show anything).
                // The tap toggle lives on the wrapper (not just the button) so it
                // still fires when the button itself is disabled -- most cards aren't
                // flip-clickable, and a disabled <button> never dispatches a click.
                // setActiveTooltip/toggleActiveTooltip (not local state) -- see
                // activeTooltip.ts's doc comment for why "only one tooltip open
                // anywhere in the app" needs to be a shared store, not per-component.
                onMouseEnter={hasHover ? () => setActiveTooltip(tooltipId) : undefined}
                onMouseLeave={hasHover ? () => clearActiveTooltip(tooltipId) : undefined}
                onClick={
                  hasHover
                    ? undefined
                    : (e) => {
                        e.stopPropagation();
                        toggleActiveTooltip(tooltipId);
                      }
                }
              >
                <button
                  // Not a native `disabled` attribute -- see Hand.tsx's own card
                  // button for why: disabled buttons unreliably suppress mouse events
                  // across browsers, including mouseenter on the wrapping div above
                  // (which is what actually listens for hover), silently killing this
                  // card's hover/tooltip whenever it isn't flip-clickable right now.
                  onClick={() => {
                    if (clickable) onCellClick(pos);
                  }}
                  aria-disabled={!clickable}
                  title={clickable ? "Tap to flip face-up" : undefined}
                  className={`@container flex aspect-square w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 p-1 text-center ${ownerColorClass(state, card.ownerId)} ${
                    clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                  } ${highlighted ? "ring-2 ring-sky-400 dark:ring-sky-500" : ""}`}
                >
                  {displayFaceUp ? (
                    <>
                      {/* Keyed off the cell's own rendered size (@container), not the
                          viewport -- an 8p board's cells can be too small to show a
                          readable name even on a wide desktop screen, and a 2-3p
                          board's cells can be plenty roomy even on a phone. 72px (not
                          52px) -- verified against the longest card name
                          ("Shieldbearer") plus the button's own p-1 padding: below
                          that it still truncates with an ellipsis mid-word, which is
                          arguably worse than just not showing it at all. */}
                      <span
                        className={`hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight @[72px]:block ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                      >
                        {def.name}
                      </span>
                      <CardArt cardId={card.cardId} className={`h-1/2 w-1/2 shrink-0 ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`} />
                      <span
                        className={`text-[length:clamp(9px,26cqw,15px)] leading-none font-bold ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                      >
                        {def.base}
                      </span>
                    </>
                  ) : (
                    <span className="text-[length:clamp(12px,40cqw,20px)]">🂠</span>
                  )}
                </button>
                {activeTooltipId === tooltipId && (
                  <div className="pointer-events-none absolute -top-12 left-1/2 z-10 w-max max-w-[12rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-white shadow dark:bg-zinc-100 dark:text-black">
                    <div className="text-[10px] font-semibold leading-tight">{tooltipOwner}</div>
                    <div className="text-[10px] leading-tight">{tooltipDetail}</div>
                    {resolvedCard && (
                      <div className="mt-1 border-t border-white/20 pt-1 text-left dark:border-black/20">
                        {visibleBreakdown(resolvedCard.breakdown).map((d, j) => (
                          <div key={j} className="flex justify-between gap-3 text-[10px] whitespace-nowrap">
                            <span>{d.label}</span>
                            <span>
                              {d.amount > 0 ? "+" : ""}
                              {d.amount}
                            </span>
                          </div>
                        ))}
                        <div className="mt-0.5 flex justify-between gap-3 border-t border-white/20 pt-0.5 text-[10px] font-semibold whitespace-nowrap dark:border-black/20">
                          <span>Final</span>
                          <span>{resolvedCard.finalValue}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          }

          return (
            <button
              key={key}
              // Not a native `disabled` attribute -- a disabled button never
              // dispatches a click event at all (by spec, not just unreliably), so a
              // tap on a non-legal cell never bubbled up to the global
              // dismiss-tooltip-on-click-elsewhere listener (see activeTooltip.ts).
              // Gating the handlers' bodies instead keeps every cell equally tappable
              // for that purpose while still doing nothing when it isn't legal.
              onClick={() => {
                if (isLegal) onCellClick(pos);
              }}
              onDragOver={(e) => {
                if (isLegal) onCellDragOver(e, key);
              }}
              onDragLeave={onCellDragLeave}
              onDrop={(e) => {
                if (isLegal) onCellDrop(e, pos);
              }}
              aria-disabled={!isLegal}
              className={`aspect-square w-full rounded-md border transition-colors ${
                isLegal
                  ? dragOverKey === key
                    ? "border-emerald-600 bg-emerald-200 dark:bg-emerald-800"
                    : "border-emerald-300/70 bg-emerald-50/50 dark:border-emerald-800/70 dark:bg-emerald-950/40"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            />
          );
        })
      )}
    </div>
  );
}
