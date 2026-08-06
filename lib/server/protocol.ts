import { CardInstance, CenterEffectId, GameAction, GameState } from "@/lib/engine/types";

/** One seat at the table -- a real connected player or an AI slot filled in at Start. */
export interface SeatInfo {
  playerId: string;
  name: string;
  isAI: boolean;
  /** False for a real player whose socket has disconnected (rejoin re-attaches the same seat) -- always true for AI seats. */
  connected: boolean;
}

/** Public lobby/room state -- identical for every viewer (no hidden info here), unlike game:state. */
export interface LobbyState {
  roomCode: string;
  hostPlayerId: string;
  playerCount: number;
  centerEffect: CenterEffectId;
  seats: SeatInfo[];
  started: boolean;
  /**
   * The server's best-guess LAN-reachable origin (e.g. "http://192.168.1.5:3000") --
   * see lib/server/network.ts's getLanOrigin for why this can't just be the client's
   * own `window.location.origin`. Used to build the shareable join link.
   */
  serverOrigin: string;
}

/**
 * GameState, JSON-safe. `board` (a Map) and `passedPlayerIds` (a Set) don't survive a
 * JSON round-trip through Socket.IO's default parser, so they're flattened to a plain
 * object / array on the wire and rebuilt on receipt -- see toWireState/fromWireState.
 * Every other GameState field is already plain-JSON-shaped.
 */
export type WireGameState = Omit<GameState, "board" | "passedPlayerIds"> & {
  board: Record<string, CardInstance>;
  passedPlayerIds: string[];
};

export function toWireState(state: GameState): WireGameState {
  return {
    ...state,
    board: Object.fromEntries(state.board.entries()),
    passedPlayerIds: [...state.passedPlayerIds],
  };
}

export function fromWireState(wire: WireGameState): GameState {
  return {
    ...wire,
    board: new Map(Object.entries(wire.board)),
    passedPlayerIds: new Set(wire.passedPlayerIds),
  };
}

export type AckResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface CreateRoomPayload {
  hostName: string;
  playerCount: number;
  centerEffect: CenterEffectId;
}
export interface CreateRoomResult {
  roomCode: string;
  playerId: string;
  token: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  name: string;
}
export interface JoinRoomResult {
  playerId: string;
  token: string;
}

/** Re-attaches a fresh socket (e.g. after a page refresh) to an already-claimed seat. */
export interface RejoinPayload {
  roomCode: string;
  token: string;
}
export interface RejoinResult {
  playerId: string;
}

export interface StartRoomPayload {
  roomCode: string;
  token: string;
}

/**
 * The location can be reconfigured for a rematch (unlike player count, which is fixed
 * to the room's existing seats) -- "random" is resolved client-side into a concrete
 * CenterEffectId before this is sent, same as room:create already does, so the server
 * never needs to know about "random" as a real value.
 */
export interface RematchPayload {
  roomCode: string;
  token: string;
  centerEffect: CenterEffectId;
}

export interface GameActionPayload {
  roomCode: string;
  token: string;
  action: GameAction;
}

/**
 * Enough to decide "is this a game I'd want to join/reconnect to" from a home-screen
 * list, without exposing anything a real LobbyState viewer gets (seat tokens,
 * connection status of individual players, ...). Includes started (in-progress) rooms
 * on purpose -- the home screen still lists them so a player who navigated back to
 * home mid-game can find their way back in. Whether a *given* browser can actually act
 * on a started room's entry (rejoin vs. a stranger who was never seated, who genuinely
 * can't join once it's started) depends on whether that browser holds stored
 * credentials for it -- a client-side-only check (see multiplayerCredentials.ts), not
 * something this summary itself encodes.
 */
export interface RoomSummary {
  roomCode: string;
  hostName: string;
  seatedCount: number;
  playerCount: number;
  centerEffect: CenterEffectId;
  started: boolean;
}

export interface ClientToServerEvents {
  "room:create": (payload: CreateRoomPayload, ack: (result: AckResult<CreateRoomResult>) => void) => void;
  "room:join": (payload: JoinRoomPayload, ack: (result: AckResult<JoinRoomResult>) => void) => void;
  "room:rejoin": (payload: RejoinPayload, ack: (result: AckResult<RejoinResult>) => void) => void;
  "room:start": (payload: StartRoomPayload, ack: (result: AckResult) => void) => void;
  /** Host-only, only once the current game has ended -- deals a fresh game to the same seat lineup without leaving the room (same join link, nobody reconnects). */
  "room:rematch": (payload: RematchPayload, ack: (result: AckResult) => void) => void;
  /** Host-only. Permanently closes the room -- lobby or mid-game, either way -- and removes it from the registry (and so from the home screen's active-sessions list). Everyone still connected gets "room:closed". Same payload shape as room:start. */
  "room:end": (payload: StartRoomPayload, ack: (result: AckResult) => void) => void;
  "game:action": (payload: GameActionPayload, ack: (result: AckResult) => void) => void;
  /** No payload -- lists every room still open for a new player to join, for the home screen's "active sessions" picker. */
  "rooms:list": (ack: (result: AckResult<{ rooms: RoomSummary[] }>) => void) => void;
}

export interface ServerToClientEvents {
  "lobby:update": (lobby: LobbyState) => void;
  /** The host closed this room (room:end) -- every socket still attached to it gets this instead of any further lobby:update/game:state. */
  "room:closed": () => void;
  /** Pushed individually per connected player socket -- never broadcast room-wide, since each player's `state` is redacted just for them. */
  "game:state": (payload: { state: WireGameState; myPlayerId: string }) => void;
}
