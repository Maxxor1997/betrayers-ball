import { GameSession } from "./session";
import { RoomSummary } from "./protocol";

/** Excludes visually ambiguous characters (0/O, 1/I) -- these get read aloud or typed off a screen across a room. */
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 4;

function randomRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

/**
 * In-memory room registry -- one process, one Map, same "in-memory to start" call the
 * design doc makes for GameState itself. A room lives until the process restarts;
 * nothing here persists across a server restart (matches the LAN/single-session scope
 * this whole feature targets, per board_game_design.md).
 */
export class RoomRegistry {
  private rooms = new Map<string, GameSession>();

  create(factory: (roomCode: string) => GameSession): GameSession {
    let code = randomRoomCode();
    while (this.rooms.has(code)) code = randomRoomCode();
    const session = factory(code);
    this.rooms.set(code, session);
    return session;
  }

  get(roomCode: string): GameSession | undefined {
    return this.rooms.get(roomCode.toUpperCase());
  }

  delete(roomCode: string): void {
    const session = this.rooms.get(roomCode.toUpperCase());
    session?.dispose();
    this.rooms.delete(roomCode.toUpperCase());
  }

  /**
   * Every room that still exists, lobby or in-progress, for the home screen's "active
   * sessions" list -- includes started games on purpose, so a player who navigated
   * back to home mid-game can find their way back to it. See RoomSummary's doc
   * comment for why listing a started room doesn't mean anyone can join it.
   */
  listSummaries(): RoomSummary[] {
    return [...this.rooms.values()].map((session) => session.getSummary());
  }
}
