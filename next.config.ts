import type { NextConfig } from "next";
import { getLanAddress } from "./lib/server/network";

// Next's dev server blocks cross-origin requests to dev-only assets/endpoints (JS
// bundles, HMR, RSC) from any origin but "localhost" by default -- since multiplayer
// desktop is a LAN feature (other devices load the app from the host's actual LAN IP,
// never localhost), that block silently breaks hydration for every device but the
// host's own: the page HTML loads, but the React bundle that would flip the mount gate
// off "Loading…" never runs. This machine's LAN address has to be allow-listed here
// for anyone else to actually be able to use the app.
const nextConfig: NextConfig = {
  allowedDevOrigins: [getLanAddress()],
  // Stops the "X-Powered-By: Next.js" response header -- free info for anyone probing
  // the stack, no functional purpose.
  poweredByHeader: false,
  // geoip-lite (see lib/server/analytics.ts) preloads its .dat lookup tables via
  // path.resolve(__dirname, ...) the instant it's required -- fine for plain Node, but
  // if Next bundles it into the route's webpack/turbopack output, the rewritten
  // __dirname no longer lines up with the real on-disk `data/` folder next to it, and
  // `next build` fails outright collecting page data for /api/track (ENOENT on
  // geoip-country.dat). Marking it external skips bundling it -- the route just
  // `require()`s the real module from node_modules at runtime instead, where its
  // __dirname-relative path resolution works exactly like plain Node.
  serverExternalPackages: ["geoip-lite"],
};

export default nextConfig;
