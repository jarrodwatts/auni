import { defineApp } from "../contract.ts";
import { tryKeyAt } from "../../try-key.ts";
import {
  buildSwapTransaction,
  JUPITER_API,
  quoteSwap,
  searchSolanaTokens,
  solanaPrice,
} from "./jupiter.ts";
import about from "./about.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Jupiter on Solana: token search and prices, and a route core's Solana swaps ask for quotes. */
export default defineApp({
  about,
  solana: {
    search: searchSolanaTokens,
    // Its search takes up to 100 comma-separated mints.
    tokens: (mints) => searchSolanaTokens(mints.join(",")),
    price: solanaPrice,
    quote: quoteSwap,
    build: buildSwapTransaction,
  },
  // One token's listing: the lightest call its key opens.
  tryKey: (_key, value) =>
    tryKeyAt(`${JUPITER_API}/tokens/v2/search?query=${SOL_MINT}`, {
      headers: { "x-api-key": value },
    }),
});
