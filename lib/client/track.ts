/**
 * Fire-and-forget analytics ping to /api/track (see that route + lib/server/analytics.ts
 * for where this actually lands -- one structured console.log line, geo-tagged from the
 * request's IP). Single-player's own client-side hook into the same log-based tracking
 * multiplayer gets for free via wireSocketServer.ts -- /play never otherwise touches the
 * server, so without this it would be invisible to "how many people are playing."
 * Never awaited by callers and never throws -- a dropped analytics ping should never be
 * something a player notices.
 */
export function track(event: string, fields: Record<string, unknown> = {}): void {
  fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, ...fields }),
    keepalive: true,
  }).catch(() => {});
}
