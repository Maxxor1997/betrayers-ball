import Link from "next/link";

/** Next's file-based 404 -- renders inside the root layout (ThemeToggle's init script, fonts, etc. all still apply), so it doesn't need any of that itself. */
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-md border-2 border-dashed border-zinc-400 text-2xl text-zinc-400 dark:border-zinc-600">
        ?
      </div>
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="max-w-xs text-sm text-zinc-600 dark:text-zinc-400">
        There&apos;s no game or page at this address -- it may have been closed, or the link might be wrong.
      </p>
      <Link
        href="/"
        className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        ◀ Home
      </Link>
    </div>
  );
}
