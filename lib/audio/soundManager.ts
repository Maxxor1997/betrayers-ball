"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether sound effects are muted -- a single shared preference for the whole app
 * (not per-component state), persisted across sessions. Same module-scoped
 * external-store shape as activeTooltip.ts (useSyncExternalStore + a listener Set),
 * chosen for the same reason: no <Provider> needs threading through every page that
 * plays a sound (/play, /join/[code], /host/[code]).
 */
const STORAGE_KEY = "board-game:sound-muted";

function loadInitialMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let muted = loadInitialMuted();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function isSoundMuted(): boolean {
  return muted;
}

export function setSoundMuted(next: boolean): void {
  if (muted === next) return;
  muted = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Private browsing / storage disabled -- the preference just won't survive a reload.
  }
  emitChange();
}

export function toggleSoundMuted(): void {
  setSoundMuted(!muted);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** getServerSnapshot always returns false (matching activeTooltip.ts's own null) -- avoids a hydration mismatch; React reconciles to the real client value immediately after mount. */
export function useSoundMuted(): boolean {
  return useSyncExternalStore(subscribe, isSoundMuted, () => false);
}

// ---- Playback engine ----
//
// Web Audio API (not a pool of <audio> elements): every sound here is a short
// one-shot, several of which can legitimately overlap (e.g. two AI turns' flips
// landing close together) -- a single AudioContext + decoded-buffer cache gives
// low-latency, overlap-safe playback without juggling element pools. Browsers block
// audio until a user gesture; since every call site here is itself the result of a
// click/tap (place a card, cast a vote, ...), the context has always already been
// allowed to run by the time playSound is ever called for real gameplay.

let audioContext: AudioContext | null = null;
const bufferCache = new Map<string, Promise<AudioBuffer>>();

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioContext) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
  }
  return audioContext;
}

function loadBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  let promise = bufferCache.get(url);
  if (!promise) {
    // .slice(0) before decodeAudioData: some browsers detach/consume the buffer they're
    // handed, which would otherwise corrupt this cache entry for a second play of the
    // same sound.
    promise = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data.slice(0)));
    bufferCache.set(url, promise);
  }
  return promise;
}

/**
 * Fire-and-forget one-shot playback. No-op while muted. Swallows any failure (a
 * missing file, a still-suspended context, a decode error) -- a sound effect
 * failing silently is far better than it ever crashing or blocking real gameplay.
 */
export function playSound(url: string, volume = 1): void {
  if (muted) return;
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  loadBuffer(ctx, url)
    .then((buffer) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(ctx.destination);
      source.start();
    })
    .catch(() => {});
}
