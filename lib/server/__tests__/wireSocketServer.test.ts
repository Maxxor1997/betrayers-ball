import { createServer, Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wireSocketServer } from "../wireSocketServer";
import { RoomRegistry } from "../rooms";
import { currentPlayerId } from "@/lib/engine/turns";
import {
  AckResult,
  ClientToServerEvents,
  CreateRoomResult,
  fromWireState,
  GameActionPayload,
  JoinRoomResult,
  LobbyState,
  RejoinResult,
  ServerToClientEvents,
  WireGameState,
} from "../protocol";

/**
 * A real HTTP + Socket.IO server on an ephemeral OS-assigned port, with real
 * socket.io-client connections talking to it -- no Next.js involved (wireSocketServer
 * is deliberately decoupled from that, see its doc comment), so this exercises the
 * actual wire protocol without needing the dev server or a browser.
 */
async function startServer() {
  const httpServer: HttpServer = createServer();
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer);
  wireSocketServer(io, new RoomRegistry(), "http://test.local:3000");
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        io.close();
        httpServer.close(() => resolve());
      }),
  };
}

function connect(url: string): ClientSocket<ServerToClientEvents, ClientToServerEvents> {
  return ioClient(url, { transports: ["websocket"], forceNew: true });
}

/** Promise-ified emit-with-ack, since the protocol is entirely ack-callback-based for requests. */
function emit<E extends keyof ClientToServerEvents>(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0]
): Promise<AckResult<object>> {
  return new Promise((resolve) => {
    // @ts-expect-error -- generic over the whole union is awkward to thread through emit's overloads; the payload/ack shapes are already checked at each call site via ClientToServerEvents.
    socket.emit(event, payload, resolve);
  });
}

describe("wireSocketServer", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let sockets: ClientSocket<ServerToClientEvents, ClientToServerEvents>[] = [];

  beforeEach(async () => {
    server = await startServer();
    sockets = [];
  });

  afterEach(async () => {
    for (const s of sockets) s.disconnect();
    await server.close();
  });

  function client(): ClientSocket<ServerToClientEvents, ClientToServerEvents> {
    const s = connect(server.url);
    sockets.push(s);
    return s;
  }

  it("creates a room and returns a host token + room code", async () => {
    const host = client();
    const result = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roomCode).toMatch(/^[A-Z]+$/);
    expect(result.token).toBeTruthy();
  });

  it("pushes the host their own initial lobby right after room:create -- not only once someone else joins", async () => {
    const host = client();
    const lobbyPromise = new Promise<LobbyState>((resolve) => host.once("lobby:update", resolve));
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    const lobby = await lobbyPromise;
    expect(lobby.seats).toHaveLength(1);
    expect(lobby.hostPlayerId).toBe(created.playerId);
  });

  it("lets a second player join and broadcasts the lobby to both -- including the joiner's own copy of the update their join caused", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");

    const hostLobbyUpdates: unknown[] = [];
    host.on("lobby:update", (lobby) => hostLobbyUpdates.push(lobby));

    const guest = client();
    // Registered before emitting room:join -- this is exactly the race that was
    // broken: the server used to broadcast lobby:update *before* the joining socket
    // was attached to the room, so the joiner never saw the update its own join caused.
    const guestOwnLobbyUpdate = new Promise<LobbyState>((resolve) => guest.once("lobby:update", resolve));
    const joined = (await emit(guest, "room:join", { roomCode: created.roomCode, name: "Bob" })) as AckResult<JoinRoomResult>;
    expect(joined.ok).toBe(true);

    const guestLobby = await guestOwnLobbyUpdate;
    expect(guestLobby.seats.map((s) => s.playerId)).toContain(joined.ok ? joined.playerId : undefined);

    await new Promise((r) => setTimeout(r, 50)); // let the host's broadcast arrive too
    expect(hostLobbyUpdates.length).toBeGreaterThan(0);
  });

  it("rejects joining a room code that doesn't exist", async () => {
    const guest = client();
    const result = await emit(guest, "room:join", { roomCode: "ZZZZ", name: "Nobody" });
    expect(result.ok).toBe(false);
  });

  it("starts the game and pushes each player their own game:state", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");

    const statePromise = new Promise((resolve) => host.once("game:state", resolve));
    const started = await emit(host, "room:start", { roomCode: created.roomCode, token: created.token });
    expect(started.ok).toBe(true);

    const push = (await statePromise) as { myPlayerId: string };
    expect(push.myPlayerId).toBe(created.playerId);
  });

  it("round-trips a real place action through the wire, redacted correctly for each player", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    const guest = client();
    const joined = (await emit(guest, "room:join", { roomCode: created.roomCode, name: "Bob" })) as AckResult<JoinRoomResult>;
    if (!joined.ok) throw new Error("setup failed");

    const initialPushes = Promise.all([
      new Promise<{ state: WireGameState }>((resolve) => host.once("game:state", resolve)),
      new Promise<{ state: WireGameState }>((resolve) => guest.once("game:state", resolve)),
    ]);
    await emit(host, "room:start", { roomCode: created.roomCode, token: created.token });
    const [hostInitial, guestInitial] = (await initialPushes).map((p) => fromWireState(p.state));

    // Whoever's actually up first (firstPlayerIndex is randomized) takes the turn --
    // this test just needs a real place action to flow through the wire, not to
    // control who goes first. Each player's own hand only shows up (non-redacted) in
    // *their own* push, so the active player's hand has to come from whichever of the
    // two initial pushes is theirs, not always the host's.
    const activePlayerId = currentPlayerId(hostInitial);
    const activeIsHost = activePlayerId === created.playerId;
    const activeToken = activeIsHost ? created.token : joined.token;
    const activeSocket = activeIsHost ? host : guest;
    const activeInitial = activeIsHost ? hostInitial : guestInitial;
    const activePlayer = activeInitial.players.find((p) => p.id === activePlayerId)!;
    const center = hostInitial.config.boardBounds.center;
    const legalPos = { x: center.x, y: center.y - 1 };

    const bothPushed = Promise.all([
      new Promise<{ state: WireGameState; myPlayerId: string }>((resolve) => host.once("game:state", resolve)),
      new Promise<{ state: WireGameState; myPlayerId: string }>((resolve) => guest.once("game:state", resolve)),
    ]);
    const result = await emit(activeSocket, "game:action", {
      roomCode: created.roomCode,
      token: activeToken,
      action: { type: "place", playerId: activePlayerId, instanceId: activePlayer.hand[0].instanceId, position: legalPos },
    });
    expect(result.ok).toBe(true);

    const [a, b] = await bothPushed;
    for (const push of [a, b]) {
      const state = fromWireState(push.state);
      expect(state.board).toBeInstanceOf(Map);
      expect(state.passedPlayerIds).toBeInstanceOf(Set);
      const placedCard = state.board.get(`${legalPos.x},${legalPos.y}`);
      expect(placedCard?.ownerId).toBe(activePlayerId);
      // The mover's own hand shrank by one everywhere it's redacted-visible: fully for
      // the mover's own push, to nothing (redacted away) for the other player's.
      const moverHand = state.players.find((p) => p.id === activePlayerId)!.hand;
      if (push.myPlayerId === activePlayerId) expect(moverHand.length).toBe(activePlayer.hand.length - 1);
      else expect(moverHand).toHaveLength(0);
    }
  });

  it("rejects a game:action with a bogus token", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    await emit(host, "room:start", { roomCode: created.roomCode, token: created.token });

    const payload: GameActionPayload = { roomCode: created.roomCode, token: "not-a-real-token", action: { type: "pass", playerId: created.playerId } };
    const result = await emit(host, "game:action", payload);
    expect(result.ok).toBe(false);
  });

  it("rejoin re-attaches a fresh socket to the same seat", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 3, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    const guest = client();
    const joined = (await emit(guest, "room:join", { roomCode: created.roomCode, name: "Bob" })) as AckResult<JoinRoomResult>;
    if (!joined.ok) throw new Error("setup failed");

    guest.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const reconnected = client();
    const rejoined = (await emit(reconnected, "room:rejoin", { roomCode: created.roomCode, token: joined.token })) as AckResult<RejoinResult>;
    expect(rejoined.ok).toBe(true);
    if (rejoined.ok) expect(rejoined.playerId).toBe(joined.playerId);
  });

  it("a mid-game rejoin gets its own game:state immediately, not just on the next unrelated change", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    const guest = client();
    const joined = (await emit(guest, "room:join", { roomCode: created.roomCode, name: "Bob" })) as AckResult<JoinRoomResult>;
    if (!joined.ok) throw new Error("setup failed");
    await emit(host, "room:start", { roomCode: created.roomCode, token: created.token });

    guest.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const reconnected = client();
    // Registered before the rejoin call -- this is the exact race that was broken:
    // GameSession.rejoin pushed game:state before the reconnecting socket had joined
    // its per-player room, so it never arrived without some *other* later change.
    const statePromise = new Promise<{ state: WireGameState; myPlayerId: string }>((resolve) => reconnected.once("game:state", resolve));
    const rejoined = await emit(reconnected, "room:rejoin", { roomCode: created.roomCode, token: joined.token });
    expect(rejoined.ok).toBe(true);

    const push = await statePromise;
    expect(push.myPlayerId).toBe(joined.playerId);
  });

  it("rooms:list surfaces a room both before and after it starts, flagging started once it has", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");

    const listBefore = await new Promise<AckResult<{ rooms: { roomCode: string; started: boolean }[] }>>((resolve) =>
      host.emit("rooms:list", resolve)
    );
    expect(listBefore.ok).toBe(true);
    if (listBefore.ok) expect(listBefore.rooms.find((r) => r.roomCode === created.roomCode)?.started).toBe(false);

    await emit(host, "room:start", { roomCode: created.roomCode, token: created.token });

    const listAfter = await new Promise<AckResult<{ rooms: { roomCode: string; started: boolean }[] }>>((resolve) =>
      host.emit("rooms:list", resolve)
    );
    expect(listAfter.ok).toBe(true);
    // Still listed -- deliberately not removed once started, so a player who navigates
    // back to home mid-game can still find and reconnect to it.
    if (listAfter.ok) expect(listAfter.rooms.find((r) => r.roomCode === created.roomCode)?.started).toBe(true);
  });

  it("room:end rejects a non-host token and leaves the room intact", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    const guest = client();
    const joined = (await emit(guest, "room:join", { roomCode: created.roomCode, name: "Bob" })) as AckResult<JoinRoomResult>;
    if (!joined.ok) throw new Error("setup failed");

    const result = await emit(guest, "room:end", { roomCode: created.roomCode, token: joined.token });
    expect(result.ok).toBe(false);

    const list = await new Promise<AckResult<{ rooms: { roomCode: string }[] }>>((resolve) => host.emit("rooms:list", resolve));
    if (list.ok) expect(list.rooms.map((r) => r.roomCode)).toContain(created.roomCode);
  });

  it("room:end removes the room and notifies everyone still connected, host or guest", async () => {
    const host = client();
    const created = (await emit(host, "room:create", { hostName: "Alice", playerCount: 2, centerEffect: "none", asDisplay: false, aiDifficulty: "medium" })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    const guest = client();
    const joined = (await emit(guest, "room:join", { roomCode: created.roomCode, name: "Bob" })) as AckResult<JoinRoomResult>;
    if (!joined.ok) throw new Error("setup failed");

    const guestClosed = new Promise<void>((resolve) => guest.once("room:closed", () => resolve()));
    const result = await emit(host, "room:end", { roomCode: created.roomCode, token: created.token });
    expect(result.ok).toBe(true);
    await guestClosed;

    const list = await new Promise<AckResult<{ rooms: { roomCode: string }[] }>>((resolve) => host.emit("rooms:list", resolve));
    if (list.ok) expect(list.rooms.map((r) => r.roomCode)).not.toContain(created.roomCode);

    const rejoinAttempt = await emit(guest, "room:rejoin", { roomCode: created.roomCode, token: joined.token });
    expect(rejoinAttempt.ok).toBe(false);
  });

  it("a display-hosted room takes no seat for the host, and the host can start/end it with real players filling every seat", async () => {
    const display = client();
    const lobbyAfterCreatePromise = new Promise<LobbyState>((resolve) => display.once("lobby:update", resolve));
    const created = (await emit(display, "room:create", {
      hostName: "Alice",
      playerCount: 2,
      centerEffect: "none",
      asDisplay: true,
      aiDifficulty: "medium",
    })) as AckResult<CreateRoomResult>;
    if (!created.ok) throw new Error("setup failed");
    expect(created.playerId).not.toBe("p0");

    const lobbyAfterCreate = await lobbyAfterCreatePromise;
    expect(lobbyAfterCreate.hostIsDisplay).toBe(true);
    expect(lobbyAfterCreate.seats).toHaveLength(0);

    const alice = client();
    const aliceJoined = (await emit(alice, "room:join", { roomCode: created.roomCode, name: "Alice" })) as AckResult<JoinRoomResult>;
    if (!aliceJoined.ok) throw new Error("setup failed");
    const bob = client();
    const bobJoined = (await emit(bob, "room:join", { roomCode: created.roomCode, name: "Bob" })) as AckResult<JoinRoomResult>;
    if (!bobJoined.ok) throw new Error("setup failed");

    const displayGotState = new Promise<{ state: WireGameState; myPlayerId: string }>((resolve) => display.once("game:state", resolve));
    const startResult = await emit(display, "room:start", { roomCode: created.roomCode, token: created.token });
    expect(startResult.ok).toBe(true);

    const push = await displayGotState;
    expect(push.myPlayerId).toBe(created.playerId);
    const state = fromWireState(push.state);
    // The display's own push is a full spectator view -- nobody's hand is visible, not even the host's (it has none).
    expect(state.players.every((p) => p.hand.length === 0)).toBe(true);

    // A real seated player can't use the display's own admin powers.
    const rejected = await emit(alice, "room:start", { roomCode: created.roomCode, token: aliceJoined.token });
    expect(rejected.ok).toBe(false);
  });
});
