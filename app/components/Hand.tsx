"use client";

import { useEffect, useRef, useState } from "react";
import { CardArt } from "@/app/components/CardArt";
import { FixedTooltip } from "@/app/components/CardCatalog";
import { setActiveTooltip, toggleActiveTooltip, useActiveTooltipId } from "@/app/hooks/activeTooltip";
import { useHasHover } from "@/app/hooks/useHasHover";
import { CARD_DEFS } from "@/lib/content/cards";
import { Board, CardId, CardInstance } from "@/lib/engine/types";

/** How long a touch has to be held before it counts as a long-press (vs. a normal tap-to-select). */
const LONG_PRESS_MS = 500;
/** Matches .hand-deal-glow's own animation-duration (globals.css) -- how long every card sits face-down and glowing before they all flip. */
const HAND_DEAL_GLOW_MS = 450;
/** Matches .card-flip-reveal's own hardcoded 0.5s duration (globals.css) -- how long the flip itself takes once it starts. */
const HAND_DEAL_FLIP_MS = 500;

export interface HandProps {
  cards: CardInstance[];
  selectedInstanceId: string | null;
  onCardClick: (instanceId: string) => void;
  onCardDragStart: (e: React.DragEvent, instanceId: string) => void;
  disabled: boolean;
  /** The viewer's own board accent (see lib/config/players.ts's playerAccentClass) -- an unselected hand card's border/fill matches this, so it's visually the same color as that same card once placed on the board, not a hardcoded blue that only happens to match a fixed seat. */
  ownerAccentClass: string;
  /** For Zeus-Born's/Dying God's max-round tint and Warlord's/Hydra's other-copy-count tint -- see Board.tsx's identical live conditions, mirrored here so a hand card already shows the same color before it's even placed. */
  round: number;
  roundCap: number;
  board: Board;
  /** True for the brief moment a freshly dealt hand should play its own reveal (every card face-down, a synchronized glow, then all flip face-up together) instead of just appearing -- see /play's own call site. Omitted (or false) renders every card normally right away, e.g. every other page that uses Hand. */
  dealing?: boolean;
  /** Fires once the deal reveal above finishes -- the caller clears its own `dealing` flag from this (see /play), same shape as RoundEndOverlay's onDone. */
  onDealt?: () => void;
}

export function Hand({
  cards,
  selectedInstanceId,
  onCardClick,
  onCardDragStart,
  disabled,
  ownerAccentClass,
  round,
  roundCap,
  board,
  dealing = false,
  onDealt,
}: HandProps) {
  // Every card sits face-down for HAND_DEAL_GLOW_MS (with a synchronized glow --
  // no stagger, since the whole point is "the hand" revealing at once, not a
  // one-by-one dealing motion), then all flip face-up together over
  // HAND_DEAL_FLIP_MS, then settle into the normal interactive render. Restarts
  // cleanly if `dealing` flips true again before finishing (a fresh game started
  // while a previous reveal was still mid-flight) since the effect's own cleanup
  // clears whatever timers were pending.
  const [dealPhase, setDealPhase] = useState<"facedown" | "flip" | "done">(dealing ? "facedown" : "done");
  useEffect(() => {
    if (!dealing) {
      setDealPhase("done");
      return;
    }
    setDealPhase("facedown");
    const flipTimer = setTimeout(() => setDealPhase("flip"), HAND_DEAL_GLOW_MS);
    const doneTimer = setTimeout(() => {
      setDealPhase("done");
      onDealt?.();
    }, HAND_DEAL_GLOW_MS + HAND_DEAL_FLIP_MS);
    return () => {
      clearTimeout(flipTimer);
      clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealing]);
  // Grouped by cardId (so duplicates sit next to each other), but the groups
  // themselves keep whatever order `cards` already arrived in -- the same order
  // Hall of Fortunes' own Pillar tiles show (see useHallOfFortunesReveal/Board.tsx,
  // which index into state.handOffers directly with no sort of their own), so a
  // freshly-drawn hand doesn't read as scrambled relative to what was just shown
  // spinning on the board. Array.prototype.sort is stable, so a plain sort-by-
  // first-occurrence-index is enough to group without otherwise reordering anything.
  const firstIndexByCardId = new Map<CardId, number>();
  for (const [i, card] of cards.entries()) {
    if (!firstIndexByCardId.has(card.cardId)) firstIndexByCardId.set(card.cardId, i);
  }
  const sortedCards = [...cards].sort((a, b) => firstIndexByCardId.get(a.cardId)! - firstIndexByCardId.get(b.cardId)!);

  const hasHover = useHasHover();
  const activeTooltipId = useActiveTooltipId();
  // Only one tooltip is ever open anywhere in the app at once (see activeTooltip.ts),
  // so a single locally-held rect is enough -- same reasoning as Board.tsx/CardCatalog's
  // own activeRect. Feeds FixedTooltip (portal, clamped to the viewport) so a card near
  // the screen edge never renders its full description off-screen.
  const [activeRect, setActiveRect] = useState<DOMRect | null>(null);
  // A single shared pair, not one per card -- only one card can ever be mid-press at a
  // time, same reasoning as activeRect above. pressTimer holds the pending long-press
  // timeout; suppressNextClick is set the moment that timer actually fires, so the
  // click event a touchend still dispatches right after doesn't also select the card
  // out from under the long-press (see the button's onClick below).
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextClick = useRef(false);

  function clearPressTimer() {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  // Cards shrink in width together (flex-basis 7rem down to a 4rem floor) to try to
  // fit one row without wrapping, but height stays fixed rather than tracking width
  // (no aspect-square) so the full name/value/effect text always has room to wrap and
  // show completely instead of truncating as the card narrows. No overflow-x-auto on
  // purpose: setting overflow-x to anything but "visible" forces the browser to also
  // clip overflow-y (a CSS rule, not a bug), which would cut off these cards' hover
  // tooltips.
  //
  // The button's own content is top-anchored (justify-start, not justify-center):
  // centering the whole name/icon/base/description stack as one block means a card
  // whose description happens to wrap onto more lines pushes its icon and base value
  // further up than a neighboring card with a short one-line description -- so a row
  // of hand cards had their icons/values sitting at different heights depending on
  // effect text length, purely as a side effect of centering. Anchoring to the top
  // keeps name/icon/base at the same fixed height on every card regardless of how
  // much room the description below them needs.
  return (
    <div className="flex w-full flex-wrap justify-center gap-2 py-1">
      {sortedCards.map((card) => {
        const def = CARD_DEFS[card.cardId];
        const selected = card.instanceId === selectedInstanceId;
        const tooltipId = `hand:${card.instanceId}`;
        // Same live tints Board.tsx applies once a card is actually placed -- a hand
        // card isn't itself on the board yet, so "other copies" here just means every
        // currently face-up copy anywhere (no self-exclusion needed, unlike Board.tsx's
        // own version of this check). Only ever counts face-up cards, same hidden-info
        // reasoning as Board.tsx's own identical conditions.
        const isZeusBornMaxed = card.cardId === "Skysplitter" && round >= roundCap;
        const isDyingGodMaxed = card.cardId === "DyingGod" && round >= roundCap;
        const otherFaceUpCopies = (cardId: CardId) => [...board.values()].filter((c) => c.faceUp && c.cardId === cardId).length;
        const isHydraOneOther = card.cardId === "Berserker" && otherFaceUpCopies("Berserker") === 1;
        const isHydraTwoPlusOther = card.cardId === "Berserker" && otherFaceUpCopies("Berserker") >= 2;
        const isWarlordOneOther = card.cardId === "Warlord" && otherFaceUpCopies("Warlord") === 1;
        const isWarlordTwoPlusOther = card.cardId === "Warlord" && otherFaceUpCopies("Warlord") >= 2;
        const colorClass = isZeusBornMaxed
          ? "text-yellow-400 dark:text-yellow-300"
          : isDyingGodMaxed || isWarlordTwoPlusOther
            ? "text-red-600 dark:text-red-500"
            : isWarlordOneOther
              ? "text-orange-600 dark:text-orange-400"
              : isHydraOneOther
                ? "text-blue-500 dark:text-blue-400"
                : isHydraTwoPlusOther
                  ? "text-green-600 dark:text-green-400"
                  : "";
        // Shared between the normal interactive button below and the flip's own
        // back-face (see dealPhase === "flip" below) -- same reasoning as Board.tsx's
        // renderFaceUpContent: the flip briefly shows this exact content mid-rotation,
        // so it has to be the literal same markup, not a re-approximation of it.
        const cardContent = (
          <>
            <span className="w-full text-[length:clamp(8px,20cqw,10px)] leading-tight break-words font-semibold">{def.name}</span>
            <CardArt cardId={card.cardId} className={`h-7 w-7 shrink-0 ${colorClass}`} />
            <span className="text-[length:clamp(14px,32cqw,20px)] leading-none font-bold">{def.base}</span>
            {/* Truncated to 2 lines, not left to grow -- keeps the card's fixed h-28
                from growing with description length. Full text is available via
                long-press/double-click below (FixedTooltip), not shown inline --
                that was tried and removed as finnicky on mobile when it was a plain
                hover tooltip. */}
            <span className="line-clamp-2 w-full text-[length:clamp(7px,16cqw,9px)] leading-tight break-words text-zinc-500 dark:text-zinc-400">
              {def.text}
            </span>
          </>
        );

        // Full h-full/w-full coverage (not scaled down) -- same as every face-down
        // card on the board itself (Board.tsx's own plain and mid-flip card backs
        // both use card-back-pattern at h-full w-full); a smaller diamond read as
        // visibly different from -- and smaller than -- the real board convention.
        // The glow class goes directly on this bordered box (not a wrapping div) so
        // the box-shadow actually follows its rounded corners -- and it's only ever
        // added in the plain facedown phase, never on the flip's own front face,
        // since the glow is meant to be long over by the time the flip starts.
        const backFace = (glowing: boolean) => (
          <div className={`flex h-28 w-full items-center justify-center rounded-md border-2 p-1.5 ${ownerAccentClass} ${glowing ? "hand-deal-glow" : ""}`}>
            <div className="card-back-pattern h-full w-full text-zinc-500 opacity-40 dark:text-zinc-400" />
          </div>
        );

        return (
          <div key={card.instanceId} className="relative" style={{ flex: "1 1 7rem", minWidth: "4rem", maxWidth: "7rem" }}>
            <button
              // Not a native `disabled` attribute -- disabled buttons unreliably
              // suppress mouse events across browsers (WebKit especially), including
              // mouseenter on an ancestor that's listening for it, which was silently
              // killing this card's hover/tooltip during an opponent's turn even
              // though the listener itself lives on the wrapping div above, not this
              // button. Gating the handler body instead keeps the button a normal,
              // fully hoverable element; aria-disabled keeps it announced correctly.
              onClick={(e) => {
                // Set by a long-press that just fired (see onPointerDown below) --
                // touch still dispatches a click right after touchend, which would
                // otherwise select/deselect the card out from under the description
                // that just opened. stopPropagation is what actually keeps the
                // tooltip open: this click still bubbles all the way to `document`
                // like any other, and activeTooltip.ts's own document-level click
                // listener closes whatever tooltip is open on ANY click it doesn't
                // see stopped -- without this, the long-press's own tooltip would
                // open for a single frame and then immediately get closed by its own
                // trailing click, before ever becoming visible.
                if (suppressNextClick.current) {
                  suppressNextClick.current = false;
                  e.stopPropagation();
                  return;
                }
                if (!disabled) onCardClick(card.instanceId);
              }}
              // Desktop-only -- see the long-press handlers below for touch's
              // equivalent gesture. Two ordinary clicks fire before a dblclick (per
              // spec), which just toggles this card's selection on then off again --
              // harmless, since it never had a chance to also select a board cell in
              // between.
              onDoubleClick={
                hasHover
                  ? (e) => {
                      setActiveRect(e.currentTarget.getBoundingClientRect());
                      toggleActiveTooltip(tooltipId);
                    }
                  : undefined
              }
              // Long-press (touch only -- hasHover devices use onDoubleClick above)
              // shows the card's full rules text, same as double-click. The element
              // reference is captured synchronously here, not read off the event
              // inside the timeout callback -- a native event's currentTarget is only
              // valid for the duration of dispatch.
              onPointerDown={
                !hasHover
                  ? (e) => {
                      const el = e.currentTarget;
                      pressTimer.current = setTimeout(() => {
                        pressTimer.current = null;
                        suppressNextClick.current = true;
                        setActiveRect(el.getBoundingClientRect());
                        setActiveTooltip(tooltipId);
                      }, LONG_PRESS_MS);
                    }
                  : undefined
              }
              onPointerUp={!hasHover ? clearPressTimer : undefined}
              onPointerLeave={!hasHover ? clearPressTimer : undefined}
              onPointerCancel={!hasHover ? clearPressTimer : undefined}
              draggable={!disabled}
              onDragStart={(e) => onCardDragStart(e, card.instanceId)}
              aria-disabled={disabled}
              className={`@container flex h-28 w-full flex-col items-center justify-start gap-1 rounded-md border-2 p-1.5 text-center ${
                disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
              } ${selected ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : ownerAccentClass}`}
            >
              {cardContent}
            </button>
            {activeTooltipId === tooltipId && activeRect && <FixedTooltip rect={activeRect}>{def.fullText}</FixedTooltip>}
            {dealPhase !== "done" && (
              // Layered on TOP of the real button above (which is always mounted,
              // never torn down) rather than being the only thing rendered while
              // dealing -- an earlier version swapped between two entirely
              // different subtrees (this facedown/flip markup vs. the real button)
              // depending on dealPhase, and replacing one DOM structure with
              // another right as the flip's own rotation finished visibly flickered
              // on mobile (the browser has to un-composite the just-finished 3D
              // layer and immediately repaint fresh 2D content in the same spot).
              // Peeling an overlay away from an already-mounted, already-correct
              // button underneath has nothing to repaint when it's removed.
              <div
                // An opaque background of its own (not just whatever the flip's two
                // faces happen to paint) -- .card-flip-face only ever shows ONE face
                // at a time via backface-visibility, but neither face covers the
                // brief edge-on moment as the rotation crosses 90deg, and without
                // this the always-mounted real button underneath would show through
                // right at that instant.
                className={`absolute inset-0 z-10 h-28 rounded-md bg-white dark:bg-zinc-950 ${dealPhase === "flip" ? "[perspective:600px]" : ""}`}
              >
                {dealPhase === "flip" ? (
                  <div className="card-flip-inner">
                    <div className="card-flip-face">{backFace(false)}</div>
                    {/* @container here too, matching the real button -- cardContent's
                        font sizes are all cqw-based (clamp(...,Ncqw,...)), resolved
                        against the nearest ancestor with its own container-type.
                        Without @container on this face too, those sizes would
                        resolve against whatever ancestor further up happens to
                        establish one instead (or the viewport, if none does) --
                        visibly different from the real button's own sizing. */}
                    <div
                      className={`card-flip-face card-flip-face-back @container flex h-28 w-full flex-col items-center justify-start gap-1 rounded-md border-2 p-1.5 text-center ${ownerAccentClass}`}
                    >
                      {cardContent}
                    </div>
                  </div>
                ) : (
                  backFace(true)
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
