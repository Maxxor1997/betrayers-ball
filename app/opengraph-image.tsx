import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Betrayer's Ball — a turn-based hidden-info grid card game";

/**
 * Generated at request time from plain JSX (no PNG/JPG asset to keep in sync with the
 * real branding) -- Next's file-based Metadata API picks this up automatically for
 * both `og:image` and (paired with the `twitter.card` set in layout.tsx) the Twitter
 * card preview, so a shared link gets a real thumbnail instead of a bare title/
 * description. Colors match the dashed ownerless-tile treatment real center tiles get
 * (see Board.tsx) -- zinc-950 ground, emerald accent -- so the preview actually looks
 * like the game instead of a generic dark card.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
          background: "#09090b",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 88,
            height: 120,
            borderRadius: 10,
            border: "3px dashed #3f3f46",
          }}
        />
        <div style={{ display: "flex", fontSize: 72, fontWeight: 700, letterSpacing: -1 }}>Betrayer&apos;s Ball</div>
        <div style={{ display: "flex", fontSize: 30, color: "#a1a1aa" }}>A turn-based, hidden-info grid card game</div>
      </div>
    ),
    { ...size }
  );
}
