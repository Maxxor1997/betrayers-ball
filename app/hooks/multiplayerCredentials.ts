import { CenterEffectId } from "@/lib/engine/types";

/**
 * Per-room bearer credentials (playerId + token), persisted in localStorage so
 * closing and reopening a tab (or a page refresh) rejoins the same seat instead of
 * orphaning it -- see GameSession's rejoin() in lib/server/session.ts, which this
 * pairs with. localStorage, not sessionStorage: an earlier version deliberately used
 * sessionStorage so "each browser tab is its own player" -- but that meant a closed
 * tab lost its credential for good, with no way back into a game already in progress.
 * localStorage fixes that, and as a side effect also means a second tab in the SAME
 * browser now picks up the same stored seat instead of getting a fresh one -- see
 * app/hooks/deviceId.ts / lib/server/session.ts's deviceId guard for the deliberate,
 * explicitly-requested tightening this enables (one seat per device per room, not one
 * per tab).
 */
export interface StoredCredentials {
  playerId: string;
  token: string;
  /** Only ever set for the browser that actually created the room (see createMultiplayerRoom.ts) -- so its own lobby screen can display the password for others to read off. Never set for a browser that joined via room code, even if the room has one. */
  roomPassword?: string;
  /**
   * The RAW, pre-resolution location choice the host picked when this room was
   * created ("random" or a specific CenterEffectId) -- only ever set for the host
   * (same as roomPassword). GameState.config.centerEffect only ever holds the already-
   * resolved concrete id (see createMultiplayerRoom.ts's callers), so a one-click
   * "Play again" needs this separately to know whether a rematch should reroll a fresh
   * random location or reuse the same fixed one -- same reasoning /play's own
   * lastCenterEffectWasRandom serves for single-player's rematch.
   */
  centerEffectMode?: CenterEffectId | "random";
}

const STORAGE_PREFIX = "board-game:mp:";

function storageKey(roomCode: string): string {
  return `${STORAGE_PREFIX}${roomCode.toUpperCase()}`;
}

export function loadCredentials(roomCode: string): StoredCredentials | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storageKey(roomCode));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(roomCode: string, credentials: StoredCredentials): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(roomCode), JSON.stringify(credentials));
}

/** Called once a room is known to be gone (host ended it) -- a stale credential would otherwise just fail cleanly on the next rejoin attempt, but there's no reason to keep it around. */
export function clearCredentials(roomCode: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(storageKey(roomCode));
}
