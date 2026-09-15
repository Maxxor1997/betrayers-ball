"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a RoundEndOverlay is currently showing (any stage but "idle") -- a single
 * shared flag, same module-scoped external-store shape as activeTooltip.ts, so a
 * page's AI-turn driver can pause without RoundEndOverlay needing a bespoke callback
 * prop. Single-player (/play) is the only real consumer today: its AI turns are
 * driven client-side by a plain setTimeout effect that has no other way to know the
 * overlay is covering the board, and without this it kept right on dispatching
 * AI turns underneath the overlay -- by the time a multi-boundary reveal finished,
 * several AI turns had already played out invisibly. Multiplayer's AI turns run
 * server-side (GameSession.scheduleAiTurnIfNeeded) and are NOT affected by this --
 * pausing them for one client's own overlay wouldn't make sense with several
 * viewers each running their own reveal timing anyway.
 */
let active = false;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function isRoundEndOverlayActive(): boolean {
  return active;
}

export function setRoundEndOverlayActive(next: boolean): void {
  if (active === next) return;
  active = next;
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRoundEndOverlayActive(): boolean {
  return useSyncExternalStore(subscribe, isRoundEndOverlayActive, () => false);
}
