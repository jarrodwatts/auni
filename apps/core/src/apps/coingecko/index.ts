import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { listed, logo } from "./coingecko.ts";

/** CoinGecko: the token list that tells a known EVM token from one anyone could mint, and its artwork. */
export default defineApp({
  about,
  tokens: { listed, logo },
});
