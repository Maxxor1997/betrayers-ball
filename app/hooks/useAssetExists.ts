"use client";

import { useEffect, useState } from "react";

/**
 * True once `url` is confirmed to load successfully, via a plain `Image` load probe
 * (no server-side manifest to keep in sync as files get added one at a time) --
 * false by default and while still loading, so callers get a safe "not yet confirmed"
 * default with no flash of missing content. The browser's own HTTP cache means this
 * is only a real network request the first time a given url is ever probed in a
 * session. Shared by CardArt and LocationArt, which both need exactly this "does an
 * optional art asset exist" check before deciding what to render.
 */
export function useAssetExists(url: string): boolean {
  const [exists, setExists] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setExists(true);
    };
    img.onerror = () => {
      if (!cancelled) setExists(false);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  return exists;
}
