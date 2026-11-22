import { defineApp } from "../contract.ts";
import { KURU_STOCKS, kuruQuote } from "./kuru.ts";
import about from "./about.ts";

/** Kuru's order books on Monad: xStocks against USDC, at any size for the stocks it has books for. */
export default defineApp({
  about,
  swaps: { trades: "stocks", quote: kuruQuote, books: KURU_STOCKS },
});
