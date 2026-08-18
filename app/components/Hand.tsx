"use client";

import { CardArt } from "@/app/components/CardArt";
import { CARD_DEFS } from "@/lib/content/cards";
import { CardInstance } from "@/lib/engine/types";

export interface HandProps {
  cards: CardInstance[];
  selectedInstanceId: string | null;
  onCardClick: (instanceId: string) => void;
  onCardDragStart: (e: React.DragEvent, instanceId: string) => void;
  disabled: boolean;
  /** The viewer's own board accent (see lib/config/players.ts's playerAccentClass) -- an unselected hand card's border/fill matches this, so it's visually the same color as that same card once placed on the board, not a hardcoded blue that only happens to match a fixed seat. */
  ownerAccentClass: string;
}

export function Hand({ cards, selectedInstanceId, onCardClick, onCardDragStart, disabled, ownerAccentClass }: HandProps) {
  const sortedCards = [...cards].sort((a, b) => CARD_DEFS[a.cardId].name.localeCompare(CARD_DEFS[b.cardId].name));

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
              onClick={() => {
                if (!disabled) onCardClick(card.instanceId);
              }}
              draggable={!disabled}
              onDragStart={(e) => onCardDragStart(e, card.instanceId)}
              aria-disabled={disabled}
              className={`@container flex h-28 w-full flex-col items-center justify-start gap-1 rounded-md border-2 p-1.5 text-center ${
                disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
              } ${selected ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : ownerAccentClass}`}
            >
              <span className="w-full text-[length:clamp(8px,20cqw,10px)] leading-tight break-words font-semibold">{def.name}</span>
              <CardArt cardId={card.cardId} className="h-7 w-7 shrink-0" />
              <span className="text-[length:clamp(14px,32cqw,20px)] leading-none font-bold">{def.base}</span>
              {/* Truncated to 2 lines, not left to grow -- keeps the card's fixed h-28
                  from growing with description length. Full text is available in the
                  card catalog, not repeated here via a tooltip (removed -- finnicky on
                  mobile). */}
              <span className="line-clamp-2 w-full text-[length:clamp(7px,16cqw,9px)] leading-tight break-words text-zinc-500 dark:text-zinc-400">
                {def.text}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
