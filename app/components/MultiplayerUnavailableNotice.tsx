import { MULTIPLAYER_UNAVAILABLE_MESSAGE } from "@/app/hooks/multiplayerUnavailable";

/** Inline banner -- used wherever a page is already rendering normally and just needs
 * to say "this one feature isn't available" without blocking the rest of the UI (the
 * join/host pages' connection state, the home screen's active-sessions list). */
export function MultiplayerUnavailableBanner() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      {MULTIPLAYER_UNAVAILABLE_MESSAGE}
    </div>
  );
}

/**
 * Full popup -- used right after a user action that was specifically trying to reach
 * multiplayer (hosting/creating a room) fails, so the failure is impossible to miss.
 * `message` defaults to the generic "connection itself failed" copy, but callers
 * should pass through the actual rejection reason when they have one (e.g. the
 * device-restriction ack errors from room:create/room:join) -- otherwise a specific,
 * actionable reason like "This device already hosts an active room" gets silently
 * discarded in favor of a generic, unhelpful message.
 */
export function MultiplayerUnavailableModal({ onClose, message }: { onClose: () => void; message?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border border-zinc-300 bg-white p-5 text-center shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold">Multiplayer unavailable</h2>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          {message ?? MULTIPLAYER_UNAVAILABLE_MESSAGE}
        </p>
        <button
          onClick={onClose}
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
