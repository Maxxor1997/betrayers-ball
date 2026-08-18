/**
 * Per-room bearer credentials (playerId + token), persisted in sessionStorage so a
 * page refresh can rejoin the same seat instead of orphaning it -- see GameSession's
 * rejoin() in lib/server/session.ts, which this pairs with. sessionStorage (not
 * localStorage): each browser tab is its own player, deliberately -- two tabs on the
 * same machine joining the same room should be two separate seats, not one fighting
 * over a shared credential.
 */
export interface StoredCredentials {
  playerId: string;
  token: string;
  /** Only ever set for the browser that actually created the room (see createMultiplayerRoom.ts) -- so its own lobby screen can display the password for others to read off. Never set for a browser that joined via room code, even if the room has one. */
  roomPassword?: string;
}

const STORAGE_PREFIX = "board-game:mp:";

function storageKey(roomCode: string): string {
  return `${STORAGE_PREFIX}${roomCode.toUpperCase()}`;
}

export function loadCredentials(roomCode: string): StoredCredentials | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(storageKey(roomCode));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(roomCode: string, credentials: StoredCredentials): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(storageKey(roomCode), JSON.stringify(credentials));
}

/** Called once a room is known to be gone (host ended it) -- a stale credential would otherwise just fail cleanly on the next rejoin attempt, but there's no reason to keep it around. */
export function clearCredentials(roomCode: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(storageKey(roomCode));
}
