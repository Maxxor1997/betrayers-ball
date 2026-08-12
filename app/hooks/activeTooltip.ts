"use client";

import { useSyncExternalStore } from "react";

/**
 * One shared "which tooltip is open" id for the WHOLE app, not a per-component local
 * useState -- every tap-to-toggle tooltip (board cards, hand cards, catalog rows, turn
 * tracker rows, end-screen card names) used to track its own hover/tap state
 * independently, so tapping one didn't dismiss another (several could end up open at
 * once), and tapping "nothing" (empty background, an unrelated element) didn't dismiss
 * anything either, since nothing was listening globally. A plain module-scoped store
 * (not React Context) so no <Provider> needs threading through every page that
 * happens to render these components (/play, /join/[code], /host/[code]).
 *
 * Ids need to be globally unique across every component using this store -- callers
 * should namespace them, e.g. `board:${key}`, `hand:${instanceId}`, `catalog:${id}`.
 *
 * The module-scope `document` listeners below (guarded for SSR) are what actually
 * make "click elsewhere" and "scroll" dismiss the open tooltip:
 * - click (bubble phase): fires for any click that wasn't stopped by a trigger's own
 *   onClick -- every trigger calls `e.stopPropagation()` when it opens/toggles a
 *   tooltip, so this listener only ever sees clicks that landed somewhere else.
 * - scroll (capture phase, since scroll doesn't bubble): a FixedTooltip's position is
 *   computed once from `getBoundingClientRect()` at open time and never updated, so
 *   without this it visibly detaches from its anchor and appears "stuck" on screen
 *   while the page scrolls underneath it. Dismissing on scroll is simpler and more
 *   robust than trying to keep a fixed-position tooltip's coordinates live.
 */
type Listener = () => void;
let activeId: string | null = null;
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function setActiveTooltip(id: string | null): void {
  if (activeId === id) return;
  activeId = id;
  emitChange();
}

export function toggleActiveTooltip(id: string): void {
  setActiveTooltip(activeId === id ? null : id);
}

/** For onMouseLeave: clears the active tooltip only if it's still the one this row set -- avoids a stale leave event (e.g. from a row the pointer already left) clobbering a different tooltip a later hover already opened. */
export function clearActiveTooltip(id: string): void {
  if (activeId === id) setActiveTooltip(null);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return activeId;
}

/**
 * The currently-open tooltip's id, or null. Called once per rendering component (not
 * once per list row) -- rows then just compare `activeId === myRowId` inline, since
 * calling a hook from inside a .map() callback would violate the rules of hooks.
 */
export function useActiveTooltipId(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

if (typeof document !== "undefined") {
  document.addEventListener("click", () => setActiveTooltip(null));
  document.addEventListener("scroll", () => setActiveTooltip(null), true);
}
