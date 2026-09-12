"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Renders `value` as a scannable QR code -- used for the multiplayer join link on the
 * host/screencast lobby screen, so a phone can scan straight into `/join/[code]`
 * instead of someone typing the room code by hand. Generates a data URL client-side
 * (no network round-trip, no server-side QR dependency) and swaps it in once ready;
 * renders nothing while empty/pending rather than a broken image.
 */
export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!value) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!dataUrl) return null;
  // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a static asset next/image would optimize.
  return <img src={dataUrl} alt="Scan to join" width={size} height={size} className="rounded-md border border-zinc-300 dark:border-zinc-700" />;
}
