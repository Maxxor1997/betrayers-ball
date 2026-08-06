"use client";

import { CENTER_EFFECTS, isAvailableAtPlayerCount, selectableCenterEffects } from "@/lib/content/centerEffects";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/lib/config/players";
import { CenterEffectId } from "@/lib/engine/types";

/** Player count and center effect chosen from this popup. */
export interface NewGameSetup {
  playerCount: number;
  centerEffect: CenterEffectId | "random";
}

/**
 * Shared "start a game" popup -- used both on the home screen (before any game
 * exists, navigating to /play once confirmed) and on /play itself (the "New game"
 * button, replacing the game in progress). Full backdrop, not the lightweight
 * floating style used for in-game vote/flip prompts -- this is a blocking choice, not
 * a passive one, and on first load it needs to fully hide whatever's behind it.
 */
export function NewGameModal({
  setup,
  onChange,
  onCancel,
  onConfirm,
  confirmLabel = "Start",
}: {
  setup: NewGameSetup;
  onChange: (setup: NewGameSetup) => void;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="w-[min(90vw,20rem)] rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 font-medium">Start a new game</p>
        <label className="mb-2 flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          Players
          <select
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
            className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm dark:border-zinc-700"
          >
            {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i).map((n) => (
              <option key={n} value={n}>
                {n} (you + {n - 1} AI)
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          Center effect
          <select
            value={setup.centerEffect}
            onChange={(e) => onChange({ ...setup, centerEffect: e.target.value as CenterEffectId | "random" })}
            className="rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-sm dark:border-zinc-700"
          >
            <option value="random">Random</option>
            <option value="none">None</option>
            {selectableCenterEffects(setup.playerCount).map((id) => (
              <option key={id} value={id}>
                {CENTER_EFFECTS[id].label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
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
