import { defineApp } from "../contract.ts";
import { quoteLifiIntents } from "./lifi-intents.ts";
import about from "./about.ts";
import { listing, logo, prices } from "./tokens.ts";

/**
 * LI.FI. Its Intents on Monad, where a market maker fills xStocks against USDC, and its token
 * list, which says what an EVM token is and prices the ones the feed before it doesn't.
 */
export default defineApp({
  about,
  swaps: { trades: "stocks", quote: quoteLifiIntents },
  tokens: { prices, listing, logo },
});
