"use client";

import { CenterEffectId } from "@/lib/engine/types";

/**
 * Locations whose own art reads faint/small next to the others at the standard icon
 * size -- rendered larger (and at full opacity where the generic rendering would
 * otherwise dim it) by every LocationArt call site. A visual tweak for these specific
 * pieces of art, not a feature of the location itself.
 */
export const BOLD_LOCATION_ART_IDS = new Set<CenterEffectId>(["noMansLand", "freeCities", "frontier", "summit", "reckoning"]);

/**
 * Locations whose own art reaches close enough to its own bounding box's edges that,
 * once inscribed edge-to-edge (`mask-size: contain`) into a small, `rounded-md`
 * tile, its corners visually get clipped by the tile's own border-radius (a
 * `background-color` painted through a mask still respects `background-clip:
 * border-box`'s rounding by default) -- rendered with a small margin (see the
 * `padding`/`maskOrigin` below) so there's clearance between the art and the tile's
 * rounded corners. A visual tweak for these specific pieces of art, not a feature of
 * the location itself -- independent of BOLD_LOCATION_ART_IDS above (freeCities is
 * in both: bold makes it bigger everywhere art appears alongside text, this makes it
 * slightly smaller specifically to clear the tile's corners).
 *
 * NOTE: this used to be implemented as `mask-size: "80%"` -- a single-value
 * background-size/mask-size sets ONLY the width to that percentage; height defaults
 * to `auto`, which scales proportionally from the MASK IMAGE's own natural aspect
 * ratio, not the element's box. For a tall image (reckoning is 640x1280, a 2:1
 * ratio) inside a roughly square box, that computed to ~160% of the box's height --
 * the art overflowed the element's own box and got clipped at the top/bottom by it,
 * exactly backwards from the intended "slightly smaller than contain." A wide image
 * (championOfTheWeak, 1280x818) went the other way and rendered noticeably too
 * small. `mask-size: contain` is the only value that's guaranteed to fit within
 * bounds without distortion regardless of the source image's own aspect ratio, so
 * the margin is created by padding the element and pointing `mask-origin` at the
 * resulting content-box instead -- contain then fits within that smaller box, with
 * zero risk of overflow or of the wrong axis winning out.
 *
 * A map (not a flat set) since the right margin isn't one-size-fits-all -- kingslayer/
 * borderlands/threeHeadedDragon only needed a touch of clearance, while
 * noMansLand/reckoning's own art sits closer to their edges and wanted more.
 */
export const SHRINK_LOCATION_ART_PADDING: Partial<Record<CenterEffectId, string>> = {
  freeCities: "10%",
  kingslayer: "6%",
  borderlands: "3%",
  noMansLand: "10%",
  threeHeadedDragon: "6%",
  reckoning: "10%",
};

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
export function LocationArt({
  id,
  variant,
  className = "",
}: {
  id: CenterEffectId;
  /** Renders public/location-art/<id>-left.svg or -right.svg instead of the plain <id>.svg -- e.g. Dragon Gate's own left/right half-gate art, one half per ownerless tile. */
  variant?: "left" | "right";
  className?: string;
}) {
  const url = `/location-art/${id}${variant ? `-${variant}` : ""}.svg`;
  const padding = SHRINK_LOCATION_ART_PADDING[id];
  const maskOrigin = padding ? "content-box" : "border-box";
  return (
    <div
      className={`bg-current ${className}`}
      style={{
        padding,
        boxSizing: "border-box",
        maskImage: `url(${url})`,
        WebkitMaskImage: `url(${url})`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        maskOrigin,
        WebkitMaskOrigin: maskOrigin,
      }}
    />
  );
}
