"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Catches a render/runtime error anywhere under the root layout and shows something
 * on-brand instead of Next's generic error overlay -- still renders inside the root
 * layout (fonts, theme script), same as not-found.tsx. Must be a client component
 * (Next's error boundary contract) and takes `reset` to retry the failed subtree
 * without a full page reload -- most errors here are one-off (a stale/bad query param,
 * a transient fetch), so "try again" is worth offering before "reload the whole app."
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-md border-2 border-dashed border-rose-400 text-2xl text-rose-500 dark:border-rose-700">
        !
      </div>
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-xs text-sm text-zinc-600 dark:text-zinc-400">
        An unexpected error interrupted this page. Your game state on the server (if any) is unaffected -- this is just the page display.
      </p>
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-black"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          ◀ Home
        </Link>
      </div>
    </div>
  );
}
