"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { ClientToServerEvents, fromWireState, LobbyState, ServerToClientEvents } from "@/lib/server/protocol";
import { CenterEffectId, GameAction, GameState } from "@/lib/engine/types";
import { clearCredentials, loadCredentials, saveCredentials, StoredCredentials } from "./multiplayerCredentials";
import { MULTIPLAYER_UNAVAILABLE_MESSAGE } from "./multiplayerUnavailable";
import { CONNECT_TIMEOUT_MS } from "./socketConnectTimeout";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface MultiplayerSession {
  /** True once this socket has completed its handshake -- not the same as being seated in the room yet. */
  connected: boolean;
  /** True once the socket has failed at least one connection attempt (e.g. no Socket.IO
   * server reachable at all, like a single-player-only Vercel deploy) -- distinct from
   * simply "not connected yet," which also covers the normal brief moment before the
   * first handshake completes. The socket keeps retrying in the background regardless
   * (socket.io-client's default reconnection behavior), so this can flip back to false
   * via the ordinary `connect` handler if the server comes back. */
  connectFailed: boolean;
  lobby: LobbyState | null;
  /** Deserialized from the last game:state push (see fromWireState) -- null before the game starts. */
  gameState: GameState | null;
  myPlayerId: string | null;
  /** True once we know this browser has no stored seat for this room yet -- render a name-entry form. */
  needsName: boolean;
  /** True once the host has ended this room (room:closed) -- nothing else in this session updates further; render a "room closed" screen. */
  roomClosed: boolean;
  error: string | null;
  join: (name: string) => void;
  startGame: () => void;
  /** Host-only, only once the current game has ended -- deals a fresh game to the same seats without leaving the room. `centerEffect` should already be resolved from "random", same as room:create. */
  rematch: (centerEffect: CenterEffectId) => void;
  /** Host-only. Permanently closes the room, lobby or mid-game -- everyone still connected (including the caller) gets bounced to the "room closed" state. */
  endRoom: () => void;
  dispatch: (action: GameAction) => void;
}

/**
 * Owns the live connection for one room, for the whole time a browser tab is looking
 * at /join/[code] -- lobby through end of game. Rejoin (not join) happens
 * automatically on mount if this browser already holds credentials for this room
 * (the host, right after creating it, or anyone reloading mid-game); otherwise
 * `needsName` goes true and the caller should collect a name and call `join`.
 */
export function useMultiplayerSession(roomCode: string): MultiplayerSession {
  const socketRef = useRef<ClientSocket | null>(null);
  const credentialsRef = useRef<StoredCredentials | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [needsName, setNeedsName] = useState(false);
  const [roomClosed, setRoomClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket: ClientSocket = io({ timeout: CONNECT_TIMEOUT_MS });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setConnectFailed(false);
      const stored = loadCredentials(roomCode);
      if (!stored) {
        setNeedsName(true);
        return;
      }
      credentialsRef.current = stored;
      socket.emit("room:rejoin", { roomCode, token: stored.token }, (ack) => {
        if (ack.ok) {
          setMyPlayerId(ack.playerId);
          setNeedsName(false);
          setError(null);
        } else {
          // The stored token is no longer valid for this room (e.g. the server
          // restarted) -- fall back to asking for a name like a fresh guest.
          setError(ack.error);
          setNeedsName(true);
        }
      });
    });

    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => {
      setConnectFailed(true);
      setError(MULTIPLAYER_UNAVAILABLE_MESSAGE);
    });
    socket.on("lobby:update", (next) => setLobby(next));
    socket.on("game:state", ({ state, myPlayerId: id }) => {
      setGameState(fromWireState(state));
      setMyPlayerId(id);
    });
    socket.on("room:closed", () => {
      clearCredentials(roomCode);
      setRoomClosed(true);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomCode]);

  const join = useCallback(
    (name: string) => {
      const socket = socketRef.current;
      if (!socket) return;
      socket.emit("room:join", { roomCode, name }, (ack) => {
        if (ack.ok) {
          const credentials = { playerId: ack.playerId, token: ack.token };
          credentialsRef.current = credentials;
          saveCredentials(roomCode, credentials);
          setMyPlayerId(ack.playerId);
          setNeedsName(false);
          setError(null);
        } else {
          setError(ack.error);
        }
      });
    },
    [roomCode]
  );

  const startGame = useCallback(() => {
    const socket = socketRef.current;
    const credentials = credentialsRef.current;
    if (!socket || !credentials) return;
    socket.emit("room:start", { roomCode, token: credentials.token }, (ack) => {
      if (!ack.ok) setError(ack.error);
    });
  }, [roomCode]);

  const rematch = useCallback(
    (centerEffect: CenterEffectId) => {
      const socket = socketRef.current;
      const credentials = credentialsRef.current;
      if (!socket || !credentials) return;
      socket.emit("room:rematch", { roomCode, token: credentials.token, centerEffect }, (ack) => {
        if (!ack.ok) setError(ack.error);
      });
    },
    [roomCode]
  );

  const endRoom = useCallback(() => {
    const socket = socketRef.current;
    const credentials = credentialsRef.current;
    if (!socket || !credentials) return;
    socket.emit("room:end", { roomCode, token: credentials.token }, (ack) => {
      if (!ack.ok) setError(ack.error);
      // On success, the room:closed listener above handles the state transition --
      // it fires for this caller too, same as everyone else in the room.
    });
  }, [roomCode]);

  const dispatch = useCallback(
    (action: GameAction) => {
      const socket = socketRef.current;
      const credentials = credentialsRef.current;
      if (!socket || !credentials) return;
      socket.emit("game:action", { roomCode, token: credentials.token, action }, (ack) => {
        if (!ack.ok) setError(ack.error);
      });
    },
    [roomCode]
  );

  return { connected, connectFailed, lobby, gameState, myPlayerId, needsName, roomClosed, error, join, startGame, rematch, endRoom, dispatch };
}
