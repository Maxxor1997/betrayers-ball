import { io, Socket } from "socket.io-client";
import { ClientToServerEvents, ServerToClientEvents } from "@/lib/server/protocol";
import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";
import { saveCredentials } from "./multiplayerCredentials";
import { rememberLocalRoom } from "./localRooms";
import { getDeviceId } from "./deviceId";
import { MULTIPLAYER_UNAVAILABLE_MESSAGE } from "./multiplayerUnavailable";
import { CONNECT_TIMEOUT_MS } from "./socketConnectTimeout";

/**
 * One-shot "create a room" call for the home screen -- opens its own throwaway
 * connection just for this request (the join/lobby page opens its own real,
 * long-lived connection and re-attaches via room:rejoin using the token this saves),
 * rather than trying to hand a live socket across a client-side navigation.
 */
export function createMultiplayerRoom(
  hostName: string,
  playerCount: number,
  centerEffect: CenterEffectId,
  aiDifficulty: AiDifficulty,
  /** Jackbox-style shared screen -- the caller takes no seat, just hosts. Defaults false (the normal "host also plays" room). */
  asDisplay = false,
  /** Optional -- blank/omitted means no password, same as every call site that predates this feature. */
  password?: string,
  /**
   * The RAW, pre-resolution location choice ("random" or a specific id) -- `centerEffect`
   * above is already resolved (needed for the actual room:create payload/first game),
   * but a one-click multiplayer "Play again" needs the *unresolved* choice too, so it
   * knows whether to keep rerolling on every rematch or reuse the same fixed location.
   * Sent to the server and stored on the room itself (LobbyState.centerEffectMode) --
   * not just this browser's own credentials -- so any viewer (including a screencast
   * room's individual seated players, not just whoever created the room) can make that
   * call correctly. Defaults to `centerEffect` for any caller that never had a "random"
   * concept to begin with (e.g. tests).
   */
  centerEffectMode: CenterEffectId | "random" = centerEffect
): Promise<{ roomCode: string } | { error: string }> {
  return new Promise((resolve) => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ timeout: CONNECT_TIMEOUT_MS });
    let settled = false;
    const finish = (result: { roomCode: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      resolve(result);
    };

    socket.on("connect", () => {
      socket.emit(
        "room:create",
        { hostName, playerCount, centerEffect, asDisplay, aiDifficulty, password, deviceId: getDeviceId(), centerEffectMode },
        (ack) => {
          if (ack.ok) {
            saveCredentials(ack.roomCode, { playerId: ack.playerId, token: ack.token, roomPassword: ack.password });
            rememberLocalRoom(ack.roomCode);
            finish({ roomCode: ack.roomCode });
          } else {
            finish({ error: ack.error });
          }
        }
      );
    });
    socket.on("connect_error", () => finish({ error: MULTIPLAYER_UNAVAILABLE_MESSAGE }));
  });
}
