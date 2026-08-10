"use client";

import { useEffect, useState } from "react";
import { CardId } from "@/lib/engine/types";

/**
 * Renders a card's silhouette (public/card-art/<CardId>.svg) as a solid currentColor
 * shape via CSS mask, rather than a plain <img src> -- an <img>'s SVG content doesn't
 * reliably inherit currentColor from the surrounding page, so dark mode and the
 * "faded" face-down-at-game-end dimming (both just a `color` change on an ancestor)
 * wouldn't apply to it. A mask-image div's own background-color (bg-current) inherits
 * the ancestor's `color` normally, same as any text would, and gets clipped to the
 * SVG's shape.
 *
 * Renders nothing at all (not an empty box) until the file is confirmed to exist --
 * most cards don't have art yet, and a reserved-but-empty box would shift every other
 * element in the card's layout even with nothing visible in it. Checked once per
 * mount via a plain `Image` load probe (no server-side manifest to keep in sync as
 * files get added one at a time); the browser's own HTTP cache means this is only a
 * real network request the first time a given card's art is ever probed in a session.
 */
export function CardArt({ cardId, className = "" }: { cardId: CardId; className?: string }) {
  const url = `/card-art/${cardId}.svg`;
  const [exists, setExists] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setExists(true);
    };
    img.onerror = () => {
      if (!cancelled) setExists(false);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!exists) return null;

  return (
    <div
      className={`bg-current ${className}`}
      style={{
        maskImage: `url(${url})`,
        WebkitMaskImage: `url(${url})`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}
