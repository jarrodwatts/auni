import { APP_LISTINGS } from "./app-about.ts";

/**
 * Reviewed token and stock artwork hosts, which the web's image optimizer fetches server-side:
 * core's own, then each app's (its about's `images`). A hostname is exact or `**.` plus a
 * suffix; a pathname is a prefix ending in `/**`, or else exact. Core hands out only a logo
 * these take (see servableImage), so a picture it names is one the web can draw.
 */
const CORE_IMAGES: readonly { readonly hostname: string; readonly pathname: string }[] = [
  { hostname: "xstocks-metadata.backed.fi", pathname: "/logos/tokens/**" },
  { hostname: "cdn.ondo.finance", pathname: "/tokens/logos/**" },
  { hostname: "backpack.exchange", pathname: "/api/stock-logo/**" },
  { hostname: "s3-symbol-logo.tradingview.com", pathname: "/**" },
  { hostname: "raw.githubusercontent.com", pathname: "/solana-labs/token-list/**" },
  { hostname: "raw.githubusercontent.com", pathname: "/trustwallet/assets/**" },
  { hostname: "assets.coingecko.com", pathname: "/coins/images/**" },
  { hostname: "coin-images.coingecko.com", pathname: "/coins/images/**" },
  { hostname: "cdn.dexscreener.com", pathname: "/**" },
  // EVM token artwork, as core's token listing gives it.
  { hostname: "static.debank.com", pathname: "/image/**" },
  // An app's own icon, as Google keeps it, on the card for a transaction the agent built for it.
  { hostname: "t1.gstatic.com", pathname: "/faviconV2" },
];

export const REMOTE_IMAGES = [
  ...CORE_IMAGES,
  ...APP_LISTINGS.flatMap(({ images }) => images ?? []),
];

/** Whether the web can draw this: same-origin artwork, or an https picture on a reviewed host. */
export function servableImage(src: string): boolean {
  if (src.startsWith("/")) return !src.startsWith("//");
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    REMOTE_IMAGES.some(
      ({ hostname, pathname }) =>
        (hostname.startsWith("**.")
          ? url.hostname.endsWith(hostname.slice(2))
          : url.hostname === hostname) &&
        (pathname.endsWith("/**")
          ? url.pathname.startsWith(pathname.slice(0, -2))
          : url.pathname === pathname),
    )
  );
}
