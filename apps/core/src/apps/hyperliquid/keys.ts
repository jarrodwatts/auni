import type { FillKey } from "../../money/fill-key.ts";
import about from "./about.ts";

/** A market as a person reads it: its ticker without its dex, so xyz:NVDA is NVDA and BTC is BTC. */
export function tickerOf(market: string): string {
  return market.replace(/^[a-z]+:/u, "");
}

/** A perp by the coin Hyperliquid names it ("BTC", "xyz:TSLA"), held in the account (see Perps). */
export function coinKey(coin: string): FillKey {
  return { chain: about.id, instrument: coin };
}
