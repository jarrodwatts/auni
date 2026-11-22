import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { logo } from "./dexscreener.ts";

/** DexScreener: the artwork a token's own listing carries, for tokens no other list has. */
export default defineApp({
  about,
  tokens: { logo },
});
