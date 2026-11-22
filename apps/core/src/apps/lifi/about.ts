import type { AppAbout } from "@auni/shared";

export default {
  id: "lifi",
  name: "LI.FI",
  does: "Trades stocks, and prices tokens",
  // Where the tokens it lists keep artwork no other reviewed host has (Tether Gold's on Monad).
  images: [{ hostname: "resources.cryptocompare.com", pathname: "/asset-management/**" }],
} satisfies AppAbout;
