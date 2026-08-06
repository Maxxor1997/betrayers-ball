import { io, Socket } from "socket.io-client";
import { ClientToServerEvents, ServerToClientEvents } from "@/lib/server/protocol";
import { CenterEffectId } from "@/lib/engine/types";
import { saveCredentials } from "./multiplayerCredentials";

/**
 * One-shot "create a room" call for the home screen -- opens its own throwaway
 * connection just for this request (the join/lobby page opens its own real,
 * long-lived connection and re-attaches via room:rejoin using the token this saves),
 * rather than trying to hand a live socket across a client-side navigation.
 */
export function createMultiplayerRoom(
  hostName: string,
  playerCount: number,
  centerEffect: CenterEffectId
): Promise<{ roomCode: string } | { error: string }> {
  return new Promise((resolve) => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io();
    let settled = false;
    const finish = (result: { roomCode: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      resolve(result);
    };

    socket.on("connect", () => {
      socket.emit("room:create", { hostName, playerCount, centerEffect }, (ack) => {
        if (ack.ok) {
          saveCredentials(ack.roomCode, { playerId: ack.playerId, token: ack.token });
          finish({ roomCode: ack.roomCode });
        } else {
          finish({ error: ack.error });
        }
      });
    });
    socket.on("connect_error", (err) => finish({ error: err.message || "Couldn't reach the game server." }));
  });
}
