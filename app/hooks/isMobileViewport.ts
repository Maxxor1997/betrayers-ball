/**
 * Best-effort "is this a phone-sized viewport" check for one-time defaults (e.g.
 * collapsing a secondary panel on first render) -- not live-reactive layout, which is
 * plain CSS/Tailwind responsive classes and handles window resizing for free without
 * any JS. Only ever safe to call from a code path already guaranteed to run
 * client-side post-mount (every call site here sits behind an existing mount gate);
 * the `typeof window` guard is just a defensive fallback, not a substitute for that.
 * 768px matches Tailwind's `md` breakpoint -- phones below it, tablets and up above.
 */
export function isMobileViewport(breakpointPx = 768): boolean {
  return typeof window !== "undefined" && window.innerWidth < breakpointPx;
}
