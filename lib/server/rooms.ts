import { GameSession } from "./session";
import { RoomSummary } from "./protocol";
import { ROOM_CODE_WORDS } from "./roomWords";

/** A single word (see roomWords.ts), not a random character string -- much easier to remember, type, and read aloud across a room than e.g. "QX7K". */
function randomRoomCode(): string {
  return ROOM_CODE_WORDS[Math.floor(Math.random() * ROOM_CODE_WORDS.length)].toUpperCase();
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
   * Closes out every room that's sat idle past its own timeout -- see
   * GameSession.isReapable/UNSTARTED_IDLE_TIMEOUT_MS/ENDED_IDLE_TIMEOUT_MS. Since this
   * one process's Map is shared by every visitor (no per-user isolation -- see this
   * class's own doc comment), an abandoned lobby or an ended-but-never-closed game
   * would otherwise sit here, and in everyone's rooms:list, until the process itself
   * restarts. A plain method, not a self-scheduled timer -- server.ts is the one place
   * that actually knows the real process's lifecycle, so it owns the setInterval that
   * calls this periodically; keeping the timer out of this class keeps it trivially
   * testable (call this directly with a controlled `now`, no fake-timer juggling).
   * Returns the codes it closed, for logging/tests.
   */
  reapIdleRooms(now: number = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [code, session] of this.rooms) {
      if (session.isReapable(now)) reaped.push(code);
    }
    for (const code of reaped) this.delete(code);
    return reaped;
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
