"use client";

import { useState } from "react";
import { CARD_DEFS } from "@/lib/content/cards";
import { CardId, CardInstance } from "@/lib/engine/types";

export interface HandProps {
  cards: CardInstance[];
  selectedInstanceId: string | null;
  onCardClick: (instanceId: string) => void;
  onCardDragStart: (e: React.DragEvent, instanceId: string) => void;
  /** Fires as the mouse enters/leaves a hand card, with that card's type (or null on
   * leave) -- lets the board highlight matching cards elsewhere. */
  onHoverCardId: (cardId: CardId | null) => void;
  disabled: boolean;
}

export function Hand({ cards, selectedInstanceId, onCardClick, onCardDragStart, onHoverCardId, disabled }: HandProps) {
  const sortedCards = [...cards].sort((a, b) => CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name));
  const [hoveredInstanceId, setHoveredInstanceId] = useState<string | null>(null);

  // Cards shrink in width together (flex-basis 7rem down to a 4rem floor) to try to
  // fit one row without wrapping, but height stays fixed rather than tracking width
  // (no aspect-square) so the full name/value/effect text always has room to wrap and
  // show completely instead of truncating as the card narrows. No overflow-x-auto on
  // purpose: setting overflow-x to anything but "visible" forces the browser to also
  // clip overflow-y (a CSS rule, not a bug), which would cut off these cards' hover
  // tooltips.
  return (
    <div className="flex w-full flex-wrap justify-center gap-2 py-1">
      {sortedCards.map((card) => {
        const def = CARD_DEFS[card.cardId];
        const selected = card.instanceId === selectedInstanceId;
        return (
          <div
            key={card.instanceId}
            className="relative"
            style={{ flex: "1 1 7rem", minWidth: "4rem", maxWidth: "7rem" }}
            onMouseEnter={() => {
              setHoveredInstanceId(card.instanceId);
              onHoverCardId(card.cardId);
            }}
            onMouseLeave={() => {
              setHoveredInstanceId((prev) => (prev === card.instanceId ? null : prev));
              onHoverCardId(null);
            }}
          >
            <button
              onClick={() => onCardClick(card.instanceId)}
              draggable={!disabled}
              onDragStart={(e) => onCardDragStart(e, card.instanceId)}
              disabled={disabled}
              className={`@container flex h-28 w-full flex-col items-center justify-center gap-1 rounded-md border-2 p-1.5 text-center ${
                disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
              } ${selected ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : "border-blue-400 dark:border-blue-700"}`}
            >
              <span className="w-full text-[length:clamp(8px,20cqw,10px)] leading-tight break-words font-semibold">{def.name}</span>
              <span className="text-[length:clamp(14px,32cqw,20px)] leading-none font-bold">{def.base}</span>
              <span className="w-full text-[length:clamp(7px,16cqw,9px)] leading-tight break-words text-zinc-500 dark:text-zinc-400">
                {def.text}
              </span>
            </button>
            {hoveredInstanceId === card.instanceId && (
              <div className="pointer-events-none absolute -top-9 left-1/2 z-20 w-max max-w-[12rem] -translate-x-1/2 rounded bg-zinc-900 px-2 py-1 text-center text-[10px] leading-tight text-white shadow dark:bg-zinc-100 dark:text-black">
                {def.fullText}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
