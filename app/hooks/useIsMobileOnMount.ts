import { useEffect, useState } from "react";
import { isMobileViewport } from "@/app/hooks/isMobileViewport";

/**
 * isMobileViewport()'s reading of `window`, deferred to after mount and held in state
 * -- for a page with no earlier mount gate of its own to run behind (see useMounted
 * for pages that already have one, where calling isMobileViewport() directly during
 * render is fine). Starts `false` (matching SSR's guess) and flips at most once, right
 * after mount, so the very first client render still matches what the server sent
 * before settling on the real value. Same three-line effect previously copy-pasted
 * across every page's own one-time mobile-default check (home, join/[code],
 * host/[code]) that feeds it into useDefaultCollapsed.
 */
export function useIsMobileOnMount(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => setIsMobile(isMobileViewport()), []);
  return isMobile;
}
