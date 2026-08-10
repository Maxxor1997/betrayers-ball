"use client";

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

/** Applies `theme` to <html> (via the `.dark`/`.light` classes globals.css keys off) and persists it. */
function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
  localStorage.setItem(STORAGE_KEY, theme);
}

/**
 * Light/dark toggle button. Renders nothing until mounted -- the initial theme is
 * whatever the anti-flash script in layout.tsx already applied to <html> before
 * hydration (localStorage, falling back to system preference), and reading that here
 * (rather than recomputing independently) keeps the two in sync by construction.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  if (theme === null) {
    return <span className="inline-block h-[26px] w-[68px] sm:h-[34px] sm:w-[88px]" aria-hidden />;
  }

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  // rounded-lg (not the rounded-full pill every action button uses) -- a different
  // frame shape sets this apart at a glance as a utility/nav control, not an action.
  return (
    <button
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs whitespace-nowrap hover:bg-zinc-100 sm:px-4 sm:py-1.5 sm:text-sm dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
    </button>
  );
}
