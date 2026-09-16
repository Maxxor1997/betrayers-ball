import { createServer } from "node:http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";
import { RoomRegistry } from "./lib/server/rooms";
import { wireSocketServer } from "./lib/server/wireSocketServer";
import { getLanOrigin } from "./lib/server/network";
import { ClientToServerEvents, ServerToClientEvents } from "./lib/server/protocol";

/**
 * Custom server -- required to run Socket.IO alongside Next.js on one process/port
 * (see node_modules/next/dist/docs/01-app/02-guides/custom-server.md). Everything
 * that isn't "boot Next.js and attach Socket.IO" lives in lib/server/* instead, so it
 * stays testable without this file (see lib/server/__tests__/wireSocketServer.test.ts,
 * which spins up the same wiring against a bare http server, no Next involved).
 *
 * Binds to 0.0.0.0 (all interfaces), not just localhost -- multiplayer desktop is a
 * LAN-play feature (per board_game_design.md's original architecture call: same-room
 * for now, players hit the host's local IP, no cloud deploy needed yet), so other
 * players' browsers need to reach this from elsewhere on the network.
 */
const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

/** How often to sweep for idle rooms -- see RoomRegistry.reapIdleRooms. Doesn't need to be frequent; the shortest timeout it's checking against (UNSTARTED_IDLE_TIMEOUT_MS) is an hour. */
const REAP_INTERVAL_MS = 10 * 60 * 1000;

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res));
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer);
  const serverOrigin = getLanOrigin(port);
  const registry = new RoomRegistry();
  const { pruneRateLimiters } = wireSocketServer(io, registry, serverOrigin);

  // unref -- this periodic sweep should never be the thing keeping the process alive.
  setInterval(() => registry.reapIdleRooms(), REAP_INTERVAL_MS).unref();
  setInterval(() => pruneRateLimiters(), REAP_INTERVAL_MS).unref();

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`> Ready on http://localhost:${port} (${dev ? "development" : process.env.NODE_ENV})`);
    console.log(`> LAN players can join at ${serverOrigin} -- Socket.IO attached for multiplayer`);
  });
});
