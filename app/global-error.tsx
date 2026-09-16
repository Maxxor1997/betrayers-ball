"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for an error in the root layout itself (fonts, theme script) --
 * error.tsx above can't catch that, since it renders *inside* the layout it would be
 * failing alongside. Per Next's contract, this one replaces the whole document, so it
 * has to bring its own <html>/<body> -- no shared layout, no Tailwind globals.css
 * import chain to rely on, hence the plain inline styles.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#09090b",
          color: "#fafafa",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ maxWidth: 320, fontSize: 14, color: "#a1a1aa" }}>
          The app failed to load. Reloading usually fixes this.
        </p>
        <button
          onClick={reset}
          style={{
            borderRadius: 999,
            background: "#fafafa",
            color: "#09090b",
            border: "none",
            padding: "8px 20px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
