"use client";

import { useHasHover } from "@/app/hooks/useHasHover";

/**
 * Dynamic, checklist-styled replacement for the plain instructional sentence above the
 * board during the viewer's own turn -- checks off the optional flip the moment it's
 * used, and always shows the current placement step (drag from hand, tap to confirm a
 * selected card, or pass if there's no legal move), instead of only ever describing
 * the next step in prose. Every other state (opponent's turn, voting) still renders
 * its own plain status line right next to this, in each page -- this component is
 * only ever mounted for "it's my turn, phase is playing".
 */
export function TurnActionChecklist({
  cardSelected,
  flipUnlocked,
  hasFlippedThisTurn,
  mustPass,
  placeDone = false,
}: {
  /** Whether the viewer already has a hand card selected, ready to drop on a highlighted cell. */
  cardSelected: boolean;
  flipUnlocked: boolean;
  hasFlippedThisTurn: boolean;
  mustPass: boolean;
  /** True for the brief flash right after placing a card -- see each page's own justPlaced state. Checks off the second item instead of leaving it permanently unchecked (placing normally ends the turn immediately, so there'd otherwise never be a moment where the player actually sees it tick). */
  placeDone?: boolean;
}) {
  // Hand.tsx's drag support is native HTML5 drag-and-drop, which touch devices don't
  // fire at all -- "drag" as an instruction is actively wrong there, not just an
  // alternate phrasing, so this branches on device capability rather than picking one
  // universal sentence that tries to cover both.
  const hasHover = useHasHover();
  const placeLabel = mustPass
    ? "Pass -- no legal move"
    : cardSelected
      ? hasHover
        ? "Tap a highlighted cell to place the selected card (or just drag it there)"
        : "Tap a highlighted cell to place the selected card"
      : hasHover
        ? "Drag a card from your hand onto a highlighted cell to place it"
        : "Tap a card in your hand, then tap a highlighted cell to place it";

  return (
    <div className="flex flex-col items-start gap-0.5 text-sm">
      {flipUnlocked && (
        <div
          className={`flex items-center gap-1.5 ${
            hasFlippedThisTurn ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-700 dark:text-zinc-300"
          }`}
        >
          <span>{hasFlippedThisTurn ? "☑" : "☐"}</span>
          <span>Flip a face-down card face-up (optional)</span>
        </div>
      )}
      <div
        className={`flex items-center gap-1.5 ${placeDone ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-700 dark:text-zinc-300"}`}
      >
        <span>{placeDone ? "☑" : "☐"}</span>
        <span>{placeLabel}</span>
      </div>
    </div>
  );
}
