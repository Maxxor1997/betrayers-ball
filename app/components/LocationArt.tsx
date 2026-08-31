"use client";

import { CenterEffectId } from "@/lib/engine/types";

/**
 * Renders a location's own icon (public/location-art/<CenterEffectId>.svg) as a solid
 * currentColor shape via CSS mask -- same technique as CardArt, for the same reason
 * (an <img>'s SVG content doesn't reliably inherit currentColor, so it wouldn't pick
 * up a location's own themeColorClass or respond to dark mode). Callers should gate
 * on useAssetExists themselves (see Board.tsx's ownerless-tile branch) rather than
 * this component doing it internally -- unlike a card (where art is layered alongside
 * other always-shown elements, so "render nothing until confirmed" is fine), a
 * location's tile has no other always-shown content once art replaces it, so the
 * caller needs the boolean up front to decide its whole branch, not just this piece.
 */
export function LocationArt({ id, className = "" }: { id: CenterEffectId; className?: string }) {
  const url = `/location-art/${id}.svg`;
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
