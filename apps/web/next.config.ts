import type { NextConfig } from "next";

import { GUESSED_ADDRESSES } from "./lib/guessed-addresses";
import { REMOTE_IMAGES } from "@auni/shared";
import { BROWSER_SECURITY_HEADERS } from "./lib/security-policy";

const config: NextConfig = {
  allowedDevOrigins: process.env.NODE_ENV === "development" ? ["127.0.0.1"] : undefined,
  devIndicators: false,
  // A money tool's answer can wait minutes on a send, so /core (proxy.ts) waits as long as core.
  experimental: { proxyTimeout: 120_000 },
  images: {
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    // The optimizer answers any quality outside this list with a 400; 75 is next/image's default.
    qualities: [75, 90],
    imageSizes: [32, 48, 64, 96, 128, 192, 256, 384],
    // A logo or a market's picture keeps its address for good, and the first resize of one waits
    // on its host (1.5 to 2 seconds for Polymarket's): kept a month, here and in the browser,
    // rather than next/image's four hours, so a picture seen once shows at once after.
    minimumCacheTTL: 30 * 24 * 60 * 60,
    remotePatterns: REMOTE_IMAGES.map((pattern) => ({ protocol: "https" as const, ...pattern })),
  },
  poweredByHeader: false,
  reactStrictMode: true,
  redirects: () =>
    Promise.resolve(GUESSED_ADDRESSES.map((address) => ({ ...address, permanent: false }))),
  transpilePackages: ["@auni/shared"],
  headers: () =>
    Promise.resolve([
      {
        source: "/:path*",
        headers: [...BROWSER_SECURITY_HEADERS],
      },
      {
        source: "/app/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
      },
      {
        source: "/pair",
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
      },
    ]),
};

export default config;
