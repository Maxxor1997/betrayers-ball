import { io, Socket } from "socket.io-client";
import { ClientToServerEvents, RoomSummary, ServerToClientEvents } from "@/lib/server/protocol";
import { MULTIPLAYER_UNAVAILABLE_MESSAGE } from "./multiplayerUnavailable";
import { CONNECT_TIMEOUT_MS } from "./socketConnectTimeout";

/**
 * One-shot "what rooms can I join right now" fetch for the home screen -- same
 * throwaway-connection pattern as createMultiplayerRoom (open a socket just for this
 * request, then disconnect; the actual join flow opens its own long-lived connection
 * once a room is picked).
 */
export function listMultiplayerRooms(): Promise<{ rooms: RoomSummary[] } | { error: string }> {
  return new Promise((resolve) => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ timeout: CONNECT_TIMEOUT_MS });
    let settled = false;
    const finish = (result: { rooms: RoomSummary[] } | { error: string }) => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      resolve(result);
    };

    socket.on("connect", () => {
      socket.emit("rooms:list", (ack) => {
        if (ack.ok) finish({ rooms: ack.rooms });
        else finish({ error: ack.error });
      });
    });
    socket.on("connect_error", () => finish({ error: MULTIPLAYER_UNAVAILABLE_MESSAGE }));
  });
}
