"use client";

import { useEffect, useState } from "react";

/**
 * True on devices with real hover + a precise pointer (mouse/trackpad); false on
 * touch-only devices (phones/tablets). Lets tooltip-triggering UI wire
 * onMouseEnter/onMouseLeave on the former and an explicit tap-to-toggle onClick on the
 * latter, rather than wiring both everywhere -- a tap on a touch device fires a
 * synthetic mouseenter immediately followed by click, so a click that *toggles* what
 * mouseenter just turned on cancels it out on the same tap, needing a second tap to
 * ever show anything (and reading as "doesn't work" if a card is only tapped once).
 *
 * Starts true (an SSR-safe default -- `window` isn't available yet) and corrects
 * itself once mounted; components using this should already be client-only anyway.
 */
export function useHasHover(): boolean {
  const [hasHover, setHasHover] = useState(true);
  useEffect(() => {
    setHasHover(window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  }, []);
  return hasHover;
}
