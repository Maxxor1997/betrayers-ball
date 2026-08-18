/**
 * Room codes this browser has created or joined, persisted in localStorage (not
 * sessionStorage -- unlike multiplayerCredentials.ts's per-tab seat tokens, this is
 * meant to survive across tabs and reloads: "rooms I've touched," not "which seat this
 * tab holds"). Used to filter the home screen's Active Sessions list down to rooms
 * this browser actually has a stake in, instead of every room on the deployment --
 * once the app runs on a shared public host (not just LAN), a global unfiltered list
 * exposes every stranger's game to every visitor.
 */
const STORAGE_KEY = "board-game:mp:local-rooms";

function readAll(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function rememberLocalRoom(roomCode: string): void {
  if (typeof window === "undefined") return;
  const code = roomCode.toUpperCase();
  const existing = readAll();
  if (existing.includes(code)) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...existing, code]));
}

export function isLocalRoom(roomCode: string): boolean {
  return readAll().includes(roomCode.toUpperCase());
}
