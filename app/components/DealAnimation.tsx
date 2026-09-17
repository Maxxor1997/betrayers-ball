"use client";

import { useEffect, useLayoutEffect, useState } from "react";

/** How long one card's own flight takes. */
const CARD_FLIGHT_MS = 500;
/** Gap between each card's flight starting -- so they arrive as a quick cascade, not all landing in the hand at the exact same instant. */
const CARD_STAGGER_MS = 70;
/** Roughly a hand card's own w-11/h-16-ish silhouette at a smaller, in-flight size. */
const CARD_WIDTH = 40;
const CARD_HEIGHT = 56;

/**
 * A brief, purely decorative sequence at the start of a new game: `cardCount` small
 * card-backs fly from `sourceRef`'s real on-screen position (GameStatusPanel, at
 * /play's own call site) to `targetRef`'s (the hand tray), standing in for the real
 * deal -- which the engine actually does in one instant step with no visual of its
 * own. Deliberately no full-screen backdrop (an earlier version dimmed/blurred the
 * whole board, which just let the already-dealt real hand show faintly through it --
 * defeating the illusion); this instead relies on the caller keeping the real hand at
 * opacity-0 until `onDone` fires; see /play's own call site), so there's nothing to
 * peek through in the first place.
 *
 * Calls `onDone` itself once every card has landed (or immediately, under
 * prefers-reduced-motion, or if either ref isn't attached to a real mounted element
 * for some reason) -- the caller just renders this conditionally and clears that
 * condition from onDone, no timer of its own to manage.
 */
export function DealAnimation({
  sourceRef,
  targetRef,
  cardCount,
  onDone,
}: {
  sourceRef: React.RefObject<HTMLElement | null>;
  targetRef: React.RefObject<HTMLElement | null>;
  cardCount: number;
  onDone: () => void;
}) {
  const [delta, setDelta] = useState<{ sx: number; sy: number; dx: number; dy: number } | null>(null);

  // Layout effect (not a plain effect) -- measures actual on-screen positions right
  // after the real DOM commits, before the browser paints, so the very first frame
  // already has the correct start/end points instead of flashing at (0,0) for a tick.
  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDone();
      return;
    }
    const source = sourceRef.current;
    const target = targetRef.current;
    if (!source || !target) {
      onDone();
      return;
    }
    const s = source.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const sx = s.left + s.width / 2;
    const sy = s.top + s.height / 2;
    setDelta({ sx, sy, dx: t.left + t.width / 2 - sx, dy: t.top + t.height / 2 - sy });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!delta) return;
    const totalMs = CARD_FLIGHT_MS + CARD_STAGGER_MS * Math.max(0, cardCount - 1);
    const timer = setTimeout(onDone, totalMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delta]);

  // Nothing to show yet (still measuring, or reduced-motion/missing-ref already
  // called onDone above) -- onDone handles dismissal in both of those cases, so this
  // just renders nothing rather than a misplaced flash at the wrong coordinates.
  if (!delta) return null;

  return (
    <>
      {Array.from({ length: cardCount }, (_, i) => (
        <div
          key={i}
          className="deal-fly-card pointer-events-none fixed z-40 rounded-md border-2 border-zinc-500 bg-zinc-800"
          style={
            {
              left: delta.sx - CARD_WIDTH / 2,
              top: delta.sy - CARD_HEIGHT / 2,
              width: CARD_WIDTH,
              height: CARD_HEIGHT,
              "--dx": `${delta.dx}px`,
              "--dy": `${delta.dy}px`,
              animationDelay: `${i * CARD_STAGGER_MS}ms`,
            } as React.CSSProperties
          }
        >
          <div className="card-back-pattern h-full w-full text-zinc-500" />
        </div>
      ))}
    </>
  );
}
