import type { Prices } from "../contract.ts";
import { info } from "./api.ts";
import { perpMark } from "./markets.ts";

/** A perp's price is its mark; its history is its candles' closes. */
export const hyperliquidPrices: Prices = {
  live: async (market) => (await perpMark(market))?.mark,
  async history(market, step, from) {
    const to = Date.now();
    // A builder dex's coin is named with its dex, as the account reads it: "xyz:NVDA".
    const candles = await info<{ T: number; c: string }[]>(
      {
        type: "candleSnapshot",
        req: { coin: market, interval: step, startTime: from, endTime: to },
      },
      8_000,
    );
    // A candle's close is its price as it ends; the last is still open, priced now.
    return candles.map((candle) => ({ at: Math.min(candle.T, to), price: Number(candle.c) }));
  },
};
