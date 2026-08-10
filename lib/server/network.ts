import os from "node:os";

/**
 * Best-effort LAN-reachable address for this machine -- picks the first non-internal
 * IPv4 address found. Only handles the typical single-NIC setup; falls back to
 * "localhost" (a real address, just not a useful one off-machine) if no external
 * interface is found at all -- e.g. an offline machine.
 */
export function getLanAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "localhost";
}

/**
 * The origin (scheme + host, no trailing slash) other players should be told to visit
 * to join a room -- used to build join links/QR codes. Needed because a client's
 * `window.location.origin` is useless for this purpose whenever the host loaded the
 * app via `localhost` (the overwhelmingly common case): sharing "http://localhost:3000"
 * with another device is meaningless -- each device's own "localhost" points at
 * itself, not at the host's machine.
 *
 * Two deployment shapes, two answers:
 * - LAN play (a laptop on someone's WiFi, `npm run dev`/`start` locally): there's no
 *   fixed public hostname, so this falls back to a best-effort LAN IP guess.
 * - A real hosted deploy (Render, etc.): the app has one fixed public URL that every
 *   player -- on any network -- can already reach, so that's what should be shown
 *   instead of this machine's LAN IP (which is meaningless off a real host's network,
 *   and often not even reachable there). Set `PUBLIC_ORIGIN` (e.g.
 *   "https://your-app.onrender.com", no trailing slash) in that environment to opt in;
 *   unset/empty means "assume LAN play" and keep the old behavior.
 */
export function getLanOrigin(port: number): string {
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  if (publicOrigin) return publicOrigin;
  return `http://${getLanAddress()}:${port}`;
}
