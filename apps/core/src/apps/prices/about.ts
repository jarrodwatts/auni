import type { AppAbout } from "@auni/shared";

export default {
  id: "prices",
  name: "Prices",
  does: "Watches prices for you",
  glyph: true,
  watchIcon: "chart",
  // Hyperliquid's coin art, which a starting point about a coin wears.
  images: [{ hostname: "app.hyperliquid.xyz", pathname: "/coins/**" }],
} satisfies AppAbout;
