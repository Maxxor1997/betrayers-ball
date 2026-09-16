import type { Server, Socket } from "socket.io";
import { GameSession } from "./session";
import { RoomRegistry } from "./rooms";
import { ClientToServerEvents, ServerToClientEvents } from "./protocol";
import { clientIpFromSocket, geoFor, logEvent } from "./analytics";
import { RateLimiter } from "./rateLimit";

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface SocketAttachment {
  roomCode: string;
  playerId: string;
}

/**
 * All the real-time wiring, decoupled from how the HTTP/Socket.IO server itself gets
 * bootstrapped (see server.ts) -- takes an already-constructed `io` and an empty
 * `registry`, and hooks up every client event. Kept separate from server.ts so it can
 * be exercised in tests against a real Socket.IO server on an ephemeral port, without
 * pulling in Next.js at all (see lib/server/__tests__/wireSocketServer.test.ts).
 *
 * `serverOrigin` -- see lib/server/network.ts's getLanOrigin -- is computed once by
 * the caller (it doesn't change for the life of the process) and handed to every room
 * created here, so the lobby's shareable join link is always this machine's actual
 * LAN address, never whatever `window.location.origin` the browser that happened to
 * create the room used (almost always "localhost", useless to anyone else).
 */
export function wireSocketServer(io: IOServer, registry: RoomRegistry, serverOrigin: string): { pruneRateLimiters: () => void } {
  // socket.id -> which room/player this connection last authenticated as, purely so a
  // "disconnect" event (which carries no payload of its own) knows who to mark
  // disconnected. Never consulted for authorization -- every event's own {roomCode,
  // token} payload is the actual credential, checked fresh by GameSession itself.
  const attachments = new Map<string, SocketAttachment>();

  // Guards the two operations worth throttling: creating a room (the expensive one --
  // spins up a whole GameSession) and joining one (cheap per-call, but still worth
  // capping so one visitor can't hammer a room's lobby). Keyed by IP, not socket.id --
  // a socket.id resets on every reconnect, which would make the limit trivially
  // bypassable just by reconnecting.
  const createLimiter = new RateLimiter(5, 10 * 60 * 1000);
  const joinLimiter = new RateLimiter(20, 60 * 1000);

  function attach(socket: IOSocket, roomCode: string, playerId: string): void {
    attachments.set(socket.id, { roomCode, playerId });
    // A dedicated room-of-one per player is how per-viewer redacted game:state pushes
    // reach exactly one socket without Socket.IO's normal room broadcast fanning a
    // single payload out to everyone -- see GameSession's onPlayerState wiring below.
    socket.join(`${roomCode}:${playerId}`);
    socket.join(roomCode);
  }

  io.on("connection", (socket: IOSocket) => {
    socket.on("room:create", ({ hostName, playerCount, centerEffect, asDisplay, aiDifficulty, password, deviceId, centerEffectMode }, ack) => {
      try {
        if (!createLimiter.allow(clientIpFromSocket(socket) ?? socket.id)) {
          return ack({ ok: false, error: "Too many rooms created recently. Please wait a bit and try again." });
        }
        if (registry.hasActiveRoomForDevice(deviceId)) {
          return ack({ ok: false, error: "This device already hosts an active room. Close it before starting another." });
        }
        const session = registry.create(
          (roomCode) =>
            new GameSession(
              roomCode,
              hostName?.trim() || "Host",
              playerCount,
              centerEffect,
              serverOrigin,
              {
                onLobbyChange: (lobby) => io.to(lobby.roomCode).emit("lobby:update", lobby),
                onPlayerState: (playerId, state) => io.to(`${roomCode}:${playerId}`).emit("game:state", { state, myPlayerId: playerId }),
              },
              undefined,
              asDisplay,
              aiDifficulty,
              password,
              deviceId,
              centerEffectMode
            ),
          deviceId
        );
        attach(socket, session.roomCode, session.hostPlayerId);
        // Unlike addPlayer/rejoin, GameSession's constructor never calls
        // onLobbyChange itself (there's no "change" yet, just initial state) -- so
        // without this, the host would see no lobby at all (no Start button) until a
        // second player's join happens to trigger the first real broadcast.
        socket.emit("lobby:update", session.getLobbyState());
        logEvent("room_created", {
          roomCode: session.roomCode,
          playerCount,
          centerEffectMode,
          aiDifficulty,
          asDisplay: !!asDisplay,
          ...geoFor(clientIpFromSocket(socket)),
        });
        ack({ ok: true, roomCode: session.roomCode, playerId: session.hostPlayerId, token: session.hostToken, password: session.password });
      } catch (err) {
        ack({ ok: false, error: err instanceof Error ? err.message : "Couldn't create room." });
      }
    });

    socket.on("room:join", ({ roomCode, name, password, deviceId }, ack) => {
      if (!joinLimiter.allow(clientIpFromSocket(socket) ?? socket.id)) {
        return ack({ ok: false, error: "Too many join attempts recently. Please wait a bit and try again." });
      }
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      // GameSession.addPlayer broadcasts lobby:update synchronously, as part of the
      // call below -- before this socket has joined the room (attach() hasn't run
      // yet, since it needs the playerId addPlayer is about to hand back). That
      // broadcast reaches everyone *already* in the room, but not this socket, so the
      // explicit emit after attach() below is this joiner's only guaranteed copy of
      // the lobby state their own join just caused.
      const result = session.addPlayer(name?.trim() || "Player", password, deviceId);
      if ("error" in result) return ack({ ok: false, error: result.error });
      attach(socket, session.roomCode, result.playerId);
      socket.emit("lobby:update", session.getLobbyState());
      logEvent("player_joined", { roomCode: session.roomCode, ...geoFor(clientIpFromSocket(socket)) });
      ack({ ok: true, playerId: result.playerId, token: result.token });
    });

    socket.on("room:rejoin", ({ roomCode, token }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      // Same ordering gap as room:join above -- GameSession.rejoin already pushed a
      // lobby:update (and, if the game's started, a game:state) before this socket
      // was attached to receive them. Send both explicitly so a reconnecting client
      // never has to wait for someone *else* to cause the next real update first.
      const result = session.rejoin(token);
      if ("error" in result) return ack({ ok: false, error: result.error });
      attach(socket, session.roomCode, result.playerId);
      socket.emit("lobby:update", session.getLobbyState());
      const state = session.stateFor(result.playerId);
      if (state) socket.emit("game:state", { state, myPlayerId: result.playerId });
      ack({ ok: true, playerId: result.playerId });
    });

    socket.on("room:start", ({ roomCode, token }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      const result = session.start(token);
      ack("error" in result ? { ok: false, error: result.error } : { ok: true });
    });

    socket.on("room:rematch", ({ roomCode, token, centerEffect, aiDifficulty, centerEffectMode }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      const result = session.rematch(token, centerEffect, aiDifficulty, centerEffectMode);
      ack("error" in result ? { ok: false, error: result.error } : { ok: true });
    });

    socket.on("room:rematchReady", ({ roomCode, token }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      const result = session.readyForRematch(token);
      ack("error" in result ? { ok: false, error: result.error } : { ok: true });
    });

    socket.on("room:end", ({ roomCode, token }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      if (!session.isHost(token)) return ack({ ok: false, error: "Only the host can end this room." });
      io.to(session.roomCode).emit("room:closed");
      registry.delete(session.roomCode);
      ack({ ok: true });
    });

    socket.on("room:rename", ({ roomCode, token, name }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      const result = session.renameSeat(token, name);
      ack("error" in result ? { ok: false, error: result.error } : { ok: true });
    });

    socket.on("room:leave", ({ roomCode, token }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      const attachment = attachments.get(socket.id);
      const result = session.leaveLobby(token);
      if ("error" in result) return ack({ ok: false, error: result.error });
      // Detach this socket from the room it just left -- otherwise it would keep
      // receiving lobby:update broadcasts (and, if the room later starts, game:state)
      // for a room it's no longer seated in.
      if (attachment && attachment.roomCode === roomCode) {
        socket.leave(`${roomCode}:${attachment.playerId}`);
        socket.leave(roomCode);
        attachments.delete(socket.id);
      }
      ack({ ok: true });
    });

    socket.on("game:action", ({ roomCode, token, action }, ack) => {
      const session = registry.get(roomCode);
      if (!session) return ack({ ok: false, error: "No game found at that room code." });
      const result = session.dispatch(token, action);
      ack("error" in result ? { ok: false, error: result.error } : { ok: true });
    });

    socket.on("rooms:list", (ack) => {
      ack({ ok: true, rooms: registry.listSummaries() });
    });

    socket.on("disconnect", () => {
      const attachment = attachments.get(socket.id);
      attachments.delete(socket.id);
      if (!attachment) return;
      registry.get(attachment.roomCode)?.markDisconnected(attachment.playerId);
    });
  });

  return {
    /** See RateLimiter.prune's own doc comment -- caller (server.ts) sweeps this periodically alongside RoomRegistry.reapIdleRooms. */
    pruneRateLimiters: () => {
      createLimiter.prune();
      joinLimiter.prune();
    },
  };
}
