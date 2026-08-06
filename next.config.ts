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
};

export default nextConfig;
