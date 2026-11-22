import { defineApp, WatchRefused } from "../contract.ts";
import { GUIDE, priceConditionSchema } from "./condition.ts";
import { priceFacts } from "./facts.ts";
import { dexOf, mids } from "./hyperliquid.ts";
import about from "./about.ts";
import { runPrices } from "./run.ts";

/**
 * Prices: watches for price levels and moves on anything Hyperliquid trades, from its public
 * prices, on this machine, and tells the day's big moves and those of what the owner holds. It
 * needs no key, so Auni can always watch something.
 */
export default defineApp({
  about,
  watches: {
    guide: GUIDE,
    condition: priceConditionSchema,
    configured: () => true,
    async check(condition) {
      const { market } = priceConditionSchema.parse(condition);
      const listed = await mids(dexOf(market));
      if (market in listed) return;
      // The likeliest slip is a stock without its dex ("NVDA" for "xyz:NVDA").
      throw new WatchRefused(
        `Hyperliquid lists no market named ${market}. Stocks, indices and commodities go by dex and name, such as xyz:NVDA; hyperliquid_markets finds a name.`,
      );
    },
    run: (context) => runPrices(context),
  },
  facts: priceFacts,
});
