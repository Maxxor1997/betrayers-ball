import { useEffect, useState } from "react";

/**
 * True once this component has mounted on the client -- every page whose first real
 * render depends on something SSR can't see (a random shuffle, localStorage, the
 * viewport) gates on this before rendering that content, showing a plain "Loading…"
 * fallback for the one tick in between. Extracted here since the same three lines
 * (useState + useEffect(() => setMounted(true), []) + the gate itself) were
 * previously copy-pasted across every such page (play, join/[code], host/[code],
 * playtest, playtest/arena, sandbox).
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
