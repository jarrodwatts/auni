import { defineApp } from "../../apps/contract.ts";
import { ABOUT } from "./about.ts";

/** A second EVM swap route, for any pair, paying out twice what it's sold. */
export default defineApp({
  about: ABOUT.swapRoute,
  swaps: {
    trades: "any",
    quote: async ({ sellAmount }) => ({
      provider: "Fake Swap",
      buyAmount: sellAmount * 2n,
      minBuyAmount: sellAmount * 2n,
    }),
  },
});
