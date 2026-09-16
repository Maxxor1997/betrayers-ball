import geoip from "geoip-lite";
import type { Socket } from "socket.io";

/**
 * One structured JSON line per event to stdout -- Render (and any other host that just
 * tails process output) captures this for free, no log-drain setup needed. Deliberately
 * not a queue/batching system or a third-party analytics SDK: this is a hobby-scale
 * project, and "grep the log line" is enough until it isn't. `ts` first so lines sort
 * and skim naturally; `event` second so it's the first thing visible after the timestamp.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/**
 * Best-effort real client IP behind Render's (or any) reverse proxy -- the proxy
 * connection's own remote address is always the proxy itself, not the visitor, so the
 * real address rides in X-Forwarded-For instead (first entry = original client, any
 * later entries are intermediate proxies). Falls back to the raw socket address for
 * local/direct connections (e.g. `npm run dev`), where there's no proxy to have set the
 * header at all.
 */
export function clientIpFromHeaders(forwardedFor: string | string[] | undefined, remoteAddress: string | undefined): string | undefined {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwarded = raw?.split(",")[0]?.trim();
  return forwarded || remoteAddress;
}

export function clientIpFromSocket(socket: Socket): string | undefined {
  return clientIpFromHeaders(socket.handshake.headers["x-forwarded-for"], socket.handshake.address);
}

/**
 * Country/city for a log line, from geoip-lite's bundled (offline, no per-request
 * network call, no rate limit, no third party sent the visitor's IP) MaxMind-derived
 * snapshot. City-level accuracy is rough and the dataset goes stale between npm
 * releases -- fine for "roughly where are people playing from," not a fit for anything
 * that needs precision. Returns undefined fields for localhost/private IPs (dev) and
 * any IP the dataset simply doesn't recognize.
 */
export function geoFor(ip: string | undefined): { country?: string; region?: string; city?: string } {
  if (!ip) return {};
  // geoip-lite doesn't resolve IPv6-mapped IPv4 addresses (e.g. "::ffff:1.2.3.4") --
  // strip the prefix Node's own socket API adds for IPv4 connections on a dual-stack
  // listener, same normalization geoip-lite's own README recommends.
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const result = geoip.lookup(normalized);
  if (!result) return {};
  return { country: result.country, region: result.region, city: result.city };
}
