"use client";

import { AI_DIFFICULTIES, AI_DIFFICULTY_LABELS } from "@/lib/ai/difficulty";
import { CENTER_EFFECTS, isAvailableAtPlayerCount, selectableCenterEffects } from "@/lib/content/centerEffects";
import { SELECTABLE_LOBBY_SIZES } from "@/lib/config/players";
import { AiDifficulty, CenterEffectId } from "@/lib/engine/types";

/** Player count, center effect, and AI difficulty chosen from this popup. */
export interface NewGameSetup {
  playerCount: number;
  centerEffect: CenterEffectId | "random";
  aiDifficulty: AiDifficulty;
}

/**
 * Shared "start a game" popup -- used on the home screen for both single player
 * (before any game exists, navigating to /play once confirmed) and hosting a
 * multiplayer room, plus on /play itself (the "New game" button, replacing the game
 * in progress) and a multiplayer room's rematch config. Full backdrop, not the
 * lightweight floating style used for in-game vote/flip prompts -- this is a blocking
 * choice, not a passive one, and on first load it needs to fully hide whatever's
 * behind it.
 *
 * Every label+control row shares one `grid-cols-[auto_1fr]` grid (not per-row flex) so
 * every control starts at the same x position regardless of how long its label text
 * is -- "Your name" / "Players" / "Center effect" are different widths, so per-row
 * flex left each row's control starting at a different point.
 */
export function NewGameModal({
  title = "Start a new game",
  setup,
  onChange,
  onCancel,
  onConfirm,
  confirmLabel = "Start",
  /** Multiplayer hosting only -- solo play and /play's mid-game "New game" have no separate "who are you" identity to collect. */
  nameField,
  /** Multiplayer room creation only (host/display, not rematch -- a room's password is fixed for its lifetime, same as its seats). Blank stays optional/no-password, matching the room's pre-password behavior. */
  passwordField,
  /** Solo play's remaining seats are always AI; a hosted multiplayer room's remaining seats might be other joining players, only backfilled with AI at Start -- so the wording next to the player-count picker differs. */
  playerCountLabel = (n) => `${n} (you + ${n - 1} AI)`,
  /**
   * Solo play has no waiting room -- the rest of the seats are AI from the very first
   * frame, not "filled in later" -- so its caption reads differently from a
   * multiplayer lobby, where other seats might still be real players joining before
   * Start backfills whatever's left with AI. Host/display pass the multiplayer
   * wording explicitly; solo play and /play's mid-game "New game" (no separate
   * waiting room either) just take this default.
   */
  seatFillNote = "The rest of the seats are AI opponents.",
  /** False for a multiplayer rematch -- player count is fixed to the room's existing seats there, only the location is reconfigurable. */
  showPlayerCount = true,
}: {
  title?: string;
  setup: NewGameSetup;
  onChange: (setup: NewGameSetup) => void;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  nameField?: { value: string; onChange: (name: string) => void };
  passwordField?: { value: string; onChange: (password: string) => void };
  playerCountLabel?: (n: number) => string;
  seatFillNote?: string;
  showPlayerCount?: boolean;
}) {
  const controlClass = "w-full min-w-0 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm dark:border-zinc-700";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="w-[min(90vw,18rem)] rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-3 font-medium">{title}</p>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          {nameField && (
            <>
              <label htmlFor="ngm-name">Your name</label>
              <input
                id="ngm-name"
                type="text"
                value={nameField.value}
                onChange={(e) => nameField.onChange(e.target.value)}
                placeholder="Host"
                maxLength={24}
                className={controlClass}
              />
            </>
          )}
          {passwordField && (
            <>
              <label htmlFor="ngm-password">Password</label>
              <input
                id="ngm-password"
                type="text"
                value={passwordField.value}
                // Uppercased as typed (not just at comparison time server-side) so
                // what the host sees on screen to read off always matches what a
                // joiner has to type -- see GameSession's roomPassword doc comment.
                onChange={(e) => passwordField.onChange(e.target.value.toUpperCase())}
                placeholder="Optional"
                maxLength={64}
                className={`${controlClass} uppercase`}
              />
            </>
          )}
          {showPlayerCount && (
            <>
              <label htmlFor="ngm-players">Lobby size</label>
              <select
                id="ngm-players"
                value={setup.playerCount}
                onChange={(e) => {
                  const playerCount = Number(e.target.value);
                  // Reset to "random" if the effect currently picked isn't available at
                  // the new player count -- e.g. an effect that's only for larger boards.
                  const centerEffect =
                    setup.centerEffect === "random" || setup.centerEffect === "none" || isAvailableAtPlayerCount(setup.centerEffect, playerCount)
                      ? setup.centerEffect
                      : "random";
                  onChange({ ...setup, playerCount, centerEffect });
                }}
                className={controlClass}
              >
                {SELECTABLE_LOBBY_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {playerCountLabel(n)}
                  </option>
                ))}
              </select>
              <span />
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{seatFillNote}</p>
            </>
          )}
          <label htmlFor="ngm-center">Location</label>
          <select
            id="ngm-center"
            value={setup.centerEffect}
            onChange={(e) => onChange({ ...setup, centerEffect: e.target.value as CenterEffectId | "random" })}
            className={controlClass}
          >
            <option value="random">Random</option>
            <option value="none">None</option>
            {selectableCenterEffects(setup.playerCount).map((id) => (
              <option key={id} value={id}>
                {CENTER_EFFECTS[id].label}
              </option>
            ))}
          </select>
          <label htmlFor="ngm-difficulty">Difficulty</label>
          <select
            id="ngm-difficulty"
            value={setup.aiDifficulty}
            onChange={(e) => onChange({ ...setup, aiDifficulty: e.target.value as AiDifficulty })}
            className={controlClass}
          >
            {AI_DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {AI_DIFFICULTY_LABELS[d]}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button onClick={onConfirm} className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-zinc-100 dark:text-black">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
