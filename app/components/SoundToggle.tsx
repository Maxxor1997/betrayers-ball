"use client";

import { toggleSoundMuted, useSoundMuted } from "@/lib/audio/soundManager";

/**
 * Mute/unmute button for sound effects -- same frame/sizing as ThemeToggle, meant to
 * sit right next to it. Icon-only (no text label) -- a label here was squishing the
 * page title on mobile's already-tight header row; aria-label/title still carry the
 * text for accessibility and desktop hover.
 */
export function SoundToggle() {
  const muted = useSoundMuted();

  return (
    <button
      onClick={() => toggleSoundMuted()}
      aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
      title={muted ? "Unmute sound effects" : "Mute sound effects"}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-zinc-300 text-sm hover:bg-zinc-100 sm:h-[34px] sm:w-[34px] sm:text-base dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
