/**
 * Shared copy for "the Socket.IO connection itself failed" (as opposed to a rejected
 * room action like a bad room code) -- surfaced by every multiplayer entry point
 * (createMultiplayerRoom, listMultiplayerRooms, useMultiplayerSession). Deliberately a
 * fixed, friendly string rather than the raw transport error (e.g. engine.io's "xhr
 * poll error"), which single-player-only hosts like a plain Vercel deploy produce --
 * that message is meaningless to a player and just reads as a bug.
 */
export const MULTIPLAYER_UNAVAILABLE_MESSAGE = "Multiplayer isn't available right now.";
