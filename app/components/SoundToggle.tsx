"use client";

import { toggleSoundMuted, useSoundMuted } from "@/lib/audio/soundManager";

/** Mute/unmute button for sound effects -- same frame/sizing as ThemeToggle, meant to sit right next to it. */
export function SoundToggle() {
  const muted = useSoundMuted();

  return (
    <button
      onClick={() => toggleSoundMuted()}
      aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
      className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      {muted ? "🔇 Muted" : "🔊 Sound"}
    </button>
  );
}
