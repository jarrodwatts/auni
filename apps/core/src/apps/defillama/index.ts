import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { day, history, prices } from "./defillama.ts";

/** DefiLlama's coin prices: what a token or a stock is worth now, was worth, and did today. */
export default defineApp({
  about,
  tokens: { prices, history, day },
});
