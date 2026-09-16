import { NextRequest, NextResponse } from "next/server";
import { clientIpFromHeaders, geoFor, logEvent } from "@/lib/server/analytics";
import { RateLimiter } from "@/lib/server/rateLimit";

// Module-scope, so it persists across requests for the life of the process (this app
// runs as one long-lived custom server -- see server.ts -- not serverless, so this
// isn't reset per-request). Pruned inline below rather than on its own timer: hobby-
// scale traffic means the map never gets big enough for a full sweep on every request
// to matter.
const limiter = new RateLimiter(60, 60 * 1000);

/**
 * The one server touchpoint for single-player (`/play`) analytics -- unlike
 * multiplayer, single-player never talks to the Socket.IO server at all (see
 * server.ts's own doc comment: it's a purely client-side game loop), so without this
 * route those sessions would be invisible to the same log-based tracking multiplayer
 * gets for free via wireSocketServer.ts. Deliberately tiny: one event name plus
 * whatever fields the caller sends, no schema, no auth (this only ever logs, it can't
 * mutate anything) -- see lib/server/analytics.ts's own doc comment for why "structured
 * console.log line" is the whole strategy here.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = clientIpFromHeaders(request.headers.get("x-forwarded-for") ?? undefined, undefined);
  limiter.prune();
  if (!limiter.allow(ip ?? "unknown")) return NextResponse.json({ ok: false }, { status: 429 });

  const body = await request.json().catch(() => null);
  if (typeof body?.event !== "string") return NextResponse.json({ ok: false }, { status: 400 });

  const { event, ...fields } = body;
  logEvent(event, { ...fields, ...geoFor(ip) });
  return NextResponse.json({ ok: true });
}
