/**
 * A random, persistent identifier for this browser, generated once and reused --
 * localStorage-backed like localRooms.ts, deliberately not tied to any single room's
 * seat/token the way multiplayerCredentials.ts is. Sent alongside room:create/
 * room:join (see lib/server/protocol.ts's payload shapes) so the server can enforce
 * "one hosted room per device" and "one seat per device per room" -- see
 * lib/server/rooms.ts/session.ts.
 *
 * Honest scope: this identifies "same browser, same origin, same profile" -- not "same
 * physical device" in the fullest sense. A different browser, a different profile, or
 * an incognito window all look like a fresh device, same as any localStorage- or
 * cookie-based approach without invasive fingerprinting (which this app has no
 * precedent for and isn't adding). It catches the common case (someone opening a
 * second tab or reloading to dodge a one-room/one-seat limit), not a determined,
 * multi-browser attempt to evade it.
 */
const STORAGE_KEY = "board-game:device-id";

/**
 * crypto.randomUUID() is gated to secure contexts (HTTPS or localhost) -- but this
 * app's whole LAN multiplayer model (see server.ts binding 0.0.0.0, CLAUDE.md) means a
 * phone joining via a LAN IP link loads the page over plain HTTP, an insecure context
 * where randomUUID is simply not exposed (calling it throws "not a function", not a
 * graceful failure). crypto.getRandomValues() has no such restriction -- it's the
 * older, more universally-supported primitive -- so it's used directly to build an
 * RFC4122-shaped v4 UUID by hand whenever the shortcut isn't available. This id is
 * never a security boundary (just an opaque "have I seen this browser before" key), so
 * a hand-rolled UUID is exactly as fit for purpose as the built-in one.
 */
function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
