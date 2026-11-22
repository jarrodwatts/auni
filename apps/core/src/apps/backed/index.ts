import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { marketNote, stocks } from "./backed.ts";

/** Backed, which issues the xStocks: its catalog of them, and whether a stock's market is open. */
export default defineApp({
  about,
  tokens: { stocks, marketNote },
});
