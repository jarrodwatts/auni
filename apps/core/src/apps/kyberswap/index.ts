import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { quoteKyberSwap } from "./kyberswap.ts";
import { addresses, reads } from "./reader.ts";

/**
 * KyberSwap's aggregator: a route for any pair on an EVM cash chain, and a reader for the swaps
 * Claude routes through it by hand on any other chain (SKILL.md).
 */
export default defineApp({
  about,
  swaps: { trades: "any", quote: quoteKyberSwap },
  addresses,
  reads,
});
