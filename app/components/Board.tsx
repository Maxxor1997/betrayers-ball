"use client";

import { useState } from "react";
import { CardArt } from "@/app/components/CardArt";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectDescription, pseudoCardLiveValue } from "@/lib/content/centerEffects";
import { inBounds, isOwnerlessPosition } from "@/lib/engine/board";
import { PLAYER_COLOR_CLASSES } from "@/lib/config/players";
import { computeNegatedInstanceIds, ResolvedCard } from "@/lib/engine/resolution";
import { CardId, GameState, Position, posKey } from "@/lib/engine/types";
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
  /** Card type currently hovered in the hand (see HandProps.onHoverCardId) -- every
   * board card of this type whose identity is visible to the viewer gets highlighted,
   * so e.g. hovering a Warlord in hand shows every Warlord already on the board. */
  highlightedCardId: CardId | null;
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
  highlightedCardId,
  onCellClick,
  onCellDragOver,
  onCellDragLeave,
  onCellDrop,
}: BoardGridProps) {
  const { width, height } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

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
            return (
              <div
                key={key}
                className="relative"
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey((prev) => (prev === key ? null : prev))}
              >
                <div className="flex aspect-square w-full items-center justify-center rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400">
                  {displayLabel}
                </div>
                {hoveredKey === key && (
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
            // shows its full effect text -- a UI convenience, not a state change. An
            // opponent's still-hidden card shows nothing, so no info leaks before a flip.
            // The hover listener lives on the wrapper div (not the button) so it still
            // fires even when the button itself is disabled.
            const tooltipOwner = nameFor(card.ownerId);
            // Same "identity known to the viewer" rule as the tooltip above -- an
            // opponent's still-hidden card never gets highlighted, even if it secretly
            // matches, so hovering your hand can't leak what's face-down on the board.
            const identityKnown = displayFaceUp || card.ownerId === viewerId;
            const highlighted = identityKnown && highlightedCardId !== null && card.cardId === highlightedCardId;
            const tooltipDetail = displayFaceUp
              ? `${def.name} (${def.base}) — ${def.fullText}`
              : card.ownerId === viewerId
                ? `${def.name} (${def.base}) — ${def.fullText} — only visible to you`
                : "face-down card";
            // Only once the game has ended does a score breakdown exist -- see Game()'s
            // `resolvedCards`, computed once and shared with EndScreen's summary table.
            const resolvedCard = resolvedCards?.get(card.instanceId);
            return (
              <div
                key={key}
                className="relative"
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey((prev) => (prev === key ? null : prev))}
              >
                <button
                  onClick={() => onCellClick(pos)}
                  disabled={!clickable}
                  title={clickable ? "Tap to flip face-up" : undefined}
                  className={`@container flex aspect-square w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 p-1 text-center ${ownerColorClass(state, card.ownerId)} ${
                    clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                  } ${highlighted ? "ring-2 ring-sky-400 dark:ring-sky-500" : ""}`}
                >
                  {displayFaceUp ? (
                    <>
                      <span
                        className={`hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight sm:block ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                      >
                        {def.name}
                      </span>
                      <CardArt cardId={card.cardId} className={`h-2/5 w-2/5 shrink-0 ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`} />
                      <span
                        className={`text-[length:clamp(11px,34cqw,18px)] leading-none font-bold ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                      >
                        {def.base}
                      </span>
                    </>
                  ) : (
                    <span className="text-[length:clamp(12px,40cqw,20px)]">🂠</span>
                  )}
                </button>
                {hoveredKey === key && (
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
              onClick={() => onCellClick(pos)}
              onDragOver={(e) => onCellDragOver(e, key)}
              onDragLeave={onCellDragLeave}
              onDrop={(e) => onCellDrop(e, pos)}
              disabled={!isLegal}
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
