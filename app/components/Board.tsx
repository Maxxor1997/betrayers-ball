"use client";

import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import { CardArt } from "@/app/components/CardArt";
import { FixedTooltip } from "@/app/components/CardCatalog";
import { CARD_DEFS } from "@/lib/content/cards";
import { CENTER_EFFECTS, centerEffectDescription, KINGSLAYER_BASE_VALUE, KINGSLAYER_INSTANCE_ID } from "@/lib/content/centerEffects";
import { inBounds, isOwnerlessPosition, parsePosKey } from "@/lib/engine/board";
import { PLAYER_COLOR_CLASSES } from "@/lib/config/players";
import { flipBoostTargets, flipDisruptionTargets, ResolvedCard } from "@/lib/engine/resolution";
import { GameState, Position, posKey } from "@/lib/engine/types";
import { clearActiveTooltip, setActiveTooltip, toggleActiveTooltip, useActiveTooltipId } from "@/app/hooks/activeTooltip";
import { useHasHover } from "@/app/hooks/useHasHover";
import { BreakdownPopup } from "./scoreBreakdown";

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
  /**
   * True while it's the viewer's own turn -- adds a pulsing glow around the board
   * itself (see the `.turn-glow` class in globals.css). Applied directly to this
   * component's own root element (which already computes its exact rendered width via
   * inline style) rather than a wrapping `<div>` a caller might add -- a wrapper with
   * no explicit width of its own breaks this component's `width: min(100%, ...)` calc
   * (the percentage has nothing definite to resolve against, collapsing the board to
   * its min-content size) the moment it's the containing block instead of this
   * component's real parent.
   */
  highlighted?: boolean;
  /**
   * Bypasses legalCellKeys/flipTargetIds entirely -- every empty cell accepts a click
   * and every occupied cell (face-up or face-down) does too, regardless of whose turn
   * it is or the normal "only face-down cards are flip-targets" rule. Only sandbox
   * mode sets this (see app/sandbox/page.tsx, which needs to place/toggle/remove any
   * card freely) -- omitted (falsy) everywhere else, so every real game's normal
   * legality gating is completely unaffected.
   */
  forceAllClickable?: boolean;
  /**
   * Makes every occupied cell's card draggable and calls this when a drag off of it
   * starts -- only sandbox mode sets this (see app/sandbox/page.tsx, which lets a
   * placed card be dragged to a new cell, or off the board entirely to remove it).
   * Omitted (falsy) everywhere else, so no real game's board cards become draggable.
   */
  onCardDragStart?: (e: React.DragEvent, instanceId: string, pos: Position) => void;
  /** Paired with onCardDragStart -- fires when that drag ends, wherever it ends. `e.dataTransfer.dropEffect` is still "none" here if it was never accepted by a drop target (see onCellDragOver), which is how sandbox tells "dropped back onto some cell" apart from "dragged off the board entirely." */
  onCardDragEnd?: (e: React.DragEvent) => void;
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
  forceAllClickable,
  onCellClick,
  onCellDragOver,
  onCellDragLeave,
  onCellDrop,
  onCardDragStart,
  onCardDragEnd,
  highlighted: turnHighlighted,
}: BoardGridProps) {
  const { width, height } = state.config.boardBounds;
  const rows = Array.from({ length: height }, (_, y) => y);
  const cols = Array.from({ length: width }, (_, x) => x);
  const activeTooltipId = useActiveTooltipId();
  const hasHover = useHasHover();
  // Only one tooltip is ever open anywhere in the app at once (see activeTooltip.ts),
  // so a single locally-held rect is enough -- same reasoning as CardCatalog's own
  // activeRect. Feeds FixedTooltip (a portal, positioned `fixed` from real screen
  // coordinates and clamped to the viewport) instead of a plain `absolute` tooltip --
  // a board cell near the screen edge (common on a narrow phone) was otherwise
  // rendering half off-screen, unreadable.
  const [activeRect, setActiveRect] = useState<DOMRect | null>(null);
  // EndScreen's per-card breakdown rows share this same tooltip store, namespaced
  // `endscreen:${instanceId}` (see EndScreen.tsx) -- reusing that instead of adding a
  // separate onHover callback/prop means hovering (or tapping, on touch) a row in the
  // end-of-game breakdown highlights that exact card here for free, with the same
  // hover-vs-tap and click/scroll-to-dismiss behavior every other tooltip already has.
  const endScreenPrefix = "endscreen:";
  const hoveredEndCardInstanceId = activeTooltipId?.startsWith(endScreenPrefix) ? activeTooltipId.slice(endScreenPrefix.length) : null;
  // Same idea, but for a whole player rather than one card: TurnOrderTracker's row
  // hover (`turnorder:${playerId}`) and EndScreen's per-player header hover
  // (`player:${playerId}`) both reuse the same shared tooltip-id store, so hovering
  // (or tapping, on touch) either one highlights every one of that player's cards
  // here, not just a single card.
  const turnOrderPrefix = "turnorder:";
  const playerRowPrefix = "player:";
  const hoveredPlayerId = activeTooltipId?.startsWith(turnOrderPrefix)
    ? activeTooltipId.slice(turnOrderPrefix.length)
    : activeTooltipId?.startsWith(playerRowPrefix)
      ? activeTooltipId.slice(playerRowPrefix.length)
      : null;

  // Which cards are mid-flip-reveal right now -- see FLIP_ANIMATION_MS and the
  // .card-flip-* classes in globals.css for the actual 3D animation. Detected by
  // diffing against the previous render's face-up snapshot (below), not by any signal
  // the reducer itself emits -- this keeps the animation purely a rendering concern,
  // oblivious to *why* a card flipped (a real flip action, an AI's move, a forceFaceUp
  // card like Cyclops getting placed, Reckoning's redraw, anything). A card's very
  // FIRST sighting only counts once this component has already rendered the board at
  // least once (see hasMountedRef) -- otherwise reconnecting mid-game (a page refresh,
  // a spectator opening the display view) would see every already-revealed card play
  // the reveal animation at once, since they'd all be "new" to a freshly mounted
  // snapshot. After that first render, a card's first-ever sighting genuinely does
  // mean "just placed this turn" (the board starts empty and only ever grows one
  // placement at a time), so a forceFaceUp card's placement now reveals exactly like a
  // real flip does. Refs are only ever touched inside this effect (never during
  // render, per this project's stricter react-hooks/refs rule), so the
  // setState-in-effect it does trigger is accepted here the same way every page's own
  // mount-detection effect already does.
  const FLIP_ANIMATION_MS = 500;
  // A forceFaceUp card (Cyclops) never has a face-down state to rotate away from --
  // it arrives already revealed the instant it's placed, not flipped later mid-game --
  // so instead of the two-face 3D flip every other card's later flip uses, a larger
  // copy of just its icon pops up out of the real (unchanged) card and looms above the
  // board briefly (see .card-rise-overlay in globals.css). Matches that CSS
  // animation's own duration so the overlay never gets cut off mid-animation.
  const RISE_ANIMATION_MS = 700;
  // Slightly longer than the flip itself and starting from the same moment -- reads as
  // "the flip caused this," not a separate, disconnected blink, while still giving a
  // beat after the card settles for the affected cells to actually register.
  const DISRUPTION_FLASH_MS = 800;
  const hasMountedRef = useRef(false);
  const prevFaceUpRef = useRef<Map<string, boolean>>(new Map());
  const [flippingIds, setFlippingIds] = useState<Set<string>>(new Set());
  const [risingIds, setRisingIds] = useState<Set<string>>(new Set());
  // Neighbor/row/col cells a just-flipped card (Earthshaker, Chronicler, Skysplitter,
  // Suppressor/Lictor, Truthseeker/Inquisitor, PlagueBearer, PlagueRat, ...) actually
  // hits -- see flipDisruptionTargets. Flashed with a red pulse (.card-disrupted in
  // globals.css) so a disruptive card's reveal reads as *why* it matters, not just
  // that a card turned over.
  const [disruptedIds, setDisruptedIds] = useState<Set<string>>(new Set());
  // Green mirror of disruptedIds -- see flipBoostTargets. Includes the flipped card
  // itself (a self-buff, e.g. Gloryseeker's own +3 while face-up) as well as neighbors
  // a card like Hornblower buffs on flip. Flashed with .card-boosted in globals.css.
  const [boostedIds, setBoostedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevFaceUpRef.current;
    const next = new Map<string, boolean>();
    // A real, later flip (was genuinely face-down at some earlier render) vs. a card
    // arriving already face-up the moment it's first seen (only ever a forceFaceUp
    // card's placement, since the board starts empty and only grows one placement at
    // a time -- see hasMountedRef's own doc comment above for why "first sighting"
    // only counts post-mount) -- same underlying "just revealed" moment, but they get
    // two different animations (see FLIP_ANIMATION_MS/RISE_ANIMATION_MS above).
    const newlyFlipped: string[] = [];
    const newlyRisen: string[] = [];
    for (const [key, card] of state.board.entries()) {
      const prevValue = prev.get(card.instanceId);
      if (card.faceUp && prevValue === false) newlyFlipped.push(key);
      else if (card.faceUp && hasMountedRef.current && prevValue === undefined) newlyRisen.push(key);
      next.set(card.instanceId, card.faceUp);
    }
    prevFaceUpRef.current = next;
    hasMountedRef.current = true;
    const justRevealed = [...newlyFlipped, ...newlyRisen];
    if (justRevealed.length === 0) return;

    // One-shot flash: adds `ids` to whichever set `setter` manages, then removes
    // exactly those ids again after `ms` -- shared by the flip/rise/disruption/boost
    // flashes below, which all follow this same "add now, clean up later" shape.
    const flash = (ids: string[], setter: Dispatch<SetStateAction<Set<string>>>, ms: number): (() => void) | undefined => {
      if (ids.length === 0) return undefined;
      setter((current) => new Set([...current, ...ids]));
      const timer = setTimeout(() => {
        setter((current) => {
          const remaining = new Set(current);
          for (const id of ids) remaining.delete(id);
          return remaining;
        });
      }, ms);
      return () => clearTimeout(timer);
    };

    const newlyFlippedIds = newlyFlipped.map((key) => state.board.get(key)!.instanceId);
    const newlyRisenIds = newlyRisen.map((key) => state.board.get(key)!.instanceId);
    const newlyDisrupted = justRevealed.flatMap((key) => {
      const card = state.board.get(key)!;
      return flipDisruptionTargets(state.board, state.config.boardBounds, state.round, parsePosKey(key), card);
    });
    const newlyBoosted = justRevealed.flatMap((key) => {
      const card = state.board.get(key)!;
      return flipBoostTargets(state.board, state.config.boardBounds, state.round, parsePosKey(key), card);
    });

    const cleanups = [
      flash(newlyFlippedIds, setFlippingIds, FLIP_ANIMATION_MS),
      flash(newlyRisenIds, setRisingIds, RISE_ANIMATION_MS),
      flash(newlyDisrupted, setDisruptedIds, DISRUPTION_FLASH_MS),
      flash(newlyBoosted, setBoostedIds, DISRUPTION_FLASH_MS),
    ];
    return () => {
      for (const cleanup of cleanups) cleanup?.();
    };
  }, [state.board, state.config.boardBounds, state.round]);

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
      className={`grid gap-1.5 rounded-xl p-1.5 ${turnHighlighted ? "turn-glow" : ""}`}
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
          const isLegal = forceAllClickable || legalCellKeys.has(key);
          // No Man's Land's -2 hits every card on the center's row AND column (see
          // noMansLand's valueModifiers) -- a plain grey wash over every cell in that
          // cross (occupied or not) makes the debuffed zone visible at a glance,
          // instead of only discovering it card by card via a breakdown popup.
          const inNoMansLandCross =
            state.config.centerEffect === "noMansLand" &&
            (pos.x === state.config.boardBounds.center.x || pos.y === state.config.boardBounds.center.y);
          // An inset box-shadow, not a separate absolutely-positioned overlay div --
          // painted directly on each cell's own bordered/rounded box (whichever
          // element that is per branch below), so it's pixel-identical to that box no
          // matter how its own wrapper happens to be sized, instead of relying on a
          // sibling `inset-0` div to independently end up the same size.
          const noMansLandShadowClass = inNoMansLandCross ? "shadow-[inset_0_0_0_9999px_rgba(113,113,122,0.1)]" : "";

          if (isOwnerless) {
            const effect = CENTER_EFFECTS[state.config.centerEffect];
            const label = effect.ownerlessLabel ?? effect.label;
            const detail = centerEffectDescription(state.config.centerEffect, state.config);
            // Always the flat base value, never the live computed one -- some of its
            // adjacency modifiers (Bannerman's, notably) don't require face-up, so
            // showing the true live value would leak a face-down card's identity
            // before anyone actually flips it. The real end-of-game math is untouched
            // (see kingslayer's postResolution in centerEffects.ts) -- this is a
            // display-only simplification.
            const displayLabel = state.config.centerEffect === "kingslayer" ? `${label} (${KINGSLAYER_BASE_VALUE})` : label;
            // Only exists once the game has ended (see resolvedCards' own doc comment)
            // and only for Kingslayer, which is the only location whose center itself
            // has a real value/breakdown to show -- see its postResolution hook in
            // centerEffects.ts.
            const kingslayerCard = resolvedCards?.get(KINGSLAYER_INSTANCE_ID);
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
                {/* Below the threshold, the label can't fit without wrapping (which,
                    combined with the aspect-square cell, either overflows or looks
                    like a mangled two-line squeeze) -- so it's just a solid tinted
                    block instead, no text. Same idea as the card name's own
                    @container cutoff, just a different fallback since this tile has
                    no icon to fall back to. */}
                <div
                  className={`hidden aspect-square w-full items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-zinc-400 p-1 text-center text-[9px] leading-tight break-words text-zinc-400 @[52px]:flex ${noMansLandShadowClass}`}
                >
                  {displayLabel}
                </div>
                <div className={`aspect-square w-full rounded-md opacity-60 @[52px]:hidden ${effect.themeColorClass} bg-current ${noMansLandShadowClass}`} />
                {activeTooltipId === tooltipId && activeRect && (
                  <FixedTooltip rect={activeRect}>
                    {displayLabel} — {detail}
                    {kingslayerCard && (
                      <div className="mt-1 border-t border-white/20 pt-1 dark:border-black/20">
                        <BreakdownPopup breakdown={kingslayerCard.breakdown} finalValue={kingslayerCard.finalValue} />
                      </div>
                    )}
                  </FixedTooltip>
                )}
              </div>
            );
          }

          if (card) {
            const clickable = forceAllClickable || (!card.faceUp && flipTargetIds.has(card.instanceId) && !selectedInstanceId);
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
              (selectedInstanceId !== null && card.ownerId === viewerId) ||
              card.instanceId === hoveredEndCardInstanceId ||
              card.ownerId === hoveredPlayerId;
            // Shared between the plain face-up render and the mid-flip 3D reveal (see
            // flippingIds above) so the two never drift out of sync with each other.
            const faceUpContent = (
              <>
                {/* Keyed off the cell's own rendered size (@container), not the
                    viewport -- an 8p board's cells can be too small to show a
                    readable name even on a wide desktop screen, and a 2-3p board's
                    cells can be plenty roomy even on a phone. 72px (not 52px) --
                    verified against the longest card name ("Shieldbearer") plus the
                    button's own p-1 padding: below that it still truncates with an
                    ellipsis mid-word, which is arguably worse than just not showing
                    it at all. */}
                <span
                  className={`hidden w-full truncate text-[length:clamp(6px,22cqw,10px)] leading-tight @[72px]:block ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}
                >
                  {def.name}
                </span>
                <CardArt cardId={card.cardId} className={`h-1/2 w-1/2 shrink-0 ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`} />
                <span className={`text-[length:clamp(9px,26cqw,15px)] leading-none font-bold ${faded ? "text-zinc-400 dark:text-zinc-500" : ""}`}>
                  {def.base}
                </span>
              </>
            );
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
                <button
                  // Not a native `disabled` attribute -- see Hand.tsx's own card
                  // button for why: disabled buttons unreliably suppress mouse events
                  // across browsers, including mouseenter on the wrapping div above
                  // (which is what actually listens for hover), silently killing this
                  // card's hover/tooltip whenever it isn't flip-clickable right now.
                  onClick={() => {
                    if (clickable) onCellClick(pos);
                  }}
                  draggable={!!onCardDragStart}
                  onDragStart={onCardDragStart ? (e) => onCardDragStart(e, card.instanceId, pos) : undefined}
                  onDragEnd={onCardDragEnd}
                  aria-disabled={!clickable}
                  title={clickable ? "Tap to flip face-up" : undefined}
                  className={`@container flex aspect-square w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md border-2 p-1 text-center ${ownerColorClass(state, card.ownerId)} ${
                    clickable ? "cursor-pointer ring-2 ring-amber-400" : ""
                  } ${highlighted ? "ring-2 ring-sky-400 dark:ring-sky-500" : ""} ${flippingIds.has(card.instanceId) ? "[perspective:600px]" : ""} ${disruptedIds.has(card.instanceId) ? "card-disrupted" : ""} ${boostedIds.has(card.instanceId) ? "card-boosted" : ""} ${noMansLandShadowClass}`}
                >
                  {flippingIds.has(card.instanceId) ? (
                    // Briefly renders BOTH faces stacked in 3D (see .card-flip-* in
                    // globals.css) while the reveal animation plays, then this whole
                    // branch stops applying (see FLIP_ANIMATION_MS above) and settles
                    // into the plain single-branch render below, same as always.
                    <div className="card-flip-inner">
                      <div className="card-flip-face">
                        <span className="text-[length:clamp(12px,40cqw,20px)]">🂠</span>
                      </div>
                      <div className="card-flip-face card-flip-face-back flex flex-col items-center justify-center gap-0.5">
                        {faceUpContent}
                      </div>
                    </div>
                  ) : displayFaceUp ? (
                    faceUpContent
                  ) : (
                    <span className="text-[length:clamp(12px,40cqw,20px)]">🂠</span>
                  )}
                </button>
                {risingIds.has(card.instanceId) && (
                  // A forceFaceUp card (Cyclops) has no face-down state to flip away
                  // from -- it's revealed the instant it's placed, not flipped later --
                  // so instead of the two-face flip above, the real card underneath
                  // stays put at its normal size, and a larger copy of just its icon
                  // rises up out of it and looms above the board for a moment before
                  // fading, like the eye emerging (see .card-rise-overlay in
                  // globals.css). `overflow-hidden` on the button above never clips
                  // this -- it's a sibling, not a descendant, of the button.
                  <div className="card-rise-overlay pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                    <CardArt cardId={card.cardId} className="h-full w-full drop-shadow-lg" />
                  </div>
                )}
                {activeTooltipId === tooltipId && activeRect && (
                  <FixedTooltip rect={activeRect}>
                    <div className="font-semibold leading-tight">{tooltipOwner}</div>
                    <div className="leading-tight">{tooltipDetail}</div>
                    {resolvedCard && (
                      <div className="mt-1 border-t border-white/20 pt-1 dark:border-black/20">
                        <BreakdownPopup breakdown={resolvedCard.breakdown} finalValue={resolvedCard.finalValue} />
                      </div>
                    )}
                  </FixedTooltip>
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
              } ${noMansLandShadowClass}`}
            />
          );
        })
      )}
    </div>
  );
}
