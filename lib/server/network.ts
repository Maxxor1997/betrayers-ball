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
 * Best-effort LAN-reachable origin (address + port) for this machine. Needed because
 * a client's `window.location.origin` is useless for this purpose whenever the host
 * loaded the app via `localhost` (the overwhelmingly common case): sharing
 * "http://localhost:3000" with another device is meaningless -- each device's own
 * "localhost" points at itself, not at the host's machine.
 */
export function getLanOrigin(port: number): string {
  return `http://${getLanAddress()}:${port}`;
}
