import { z } from "zod";

/** How far back a move is measured, and how long a minute bar is kept for it. */
export const WINDOWS = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "24h": 1_440 } as const;

const market = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe('A Hyperliquid market: a coin ("BTC") or dex:name ("xyz:NVDA")');

/** A price crossing a level, or moving a share of itself within a window. */
export const priceConditionSchema = z.union([
  z.strictObject({
    market,
    crosses: z.enum(["above", "below"]),
    price: z.number().positive(),
  }),
  z.strictObject({
    market,
    moves: z.enum(["up", "down", "either"]),
    percent: z.number().positive().max(1_000),
    within: z.enum(Object.keys(WINDOWS) as [keyof typeof WINDOWS, ...(keyof typeof WINDOWS)[]]),
  }),
]);

export type PriceCondition = z.infer<typeof priceConditionSchema>;

export const GUIDE = `The price of anything Hyperliquid trades, checked by Auni on this machine against Hyperliquid's public prices: free, no key, near-instant. Markets go by Hyperliquid's names: crypto by coin ("BTC", "ETH", "HYPE"), and stocks, indices and commodities by dex and name ("xyz:NVDA", "xyz:GOLD"); hyperliquid_markets lists them, and a name it doesn't list is refused. A condition is one of:
- a level: {"market":"BTC","crosses":"below","price":60000} fires when the price crosses it, never just for being past it already when set up.
- a move: {"market":"xyz:NVDA","moves":"down","percent":5,"within":"24h"} fires when the price is that share below the window's high (down), above its low (up), or either; within 5m 15m 1h 4h 24h. It too fires as the move happens, not for one already made when set up.
With repeat, either fires again each time it happens anew (crosses back and over again, or moves again). Auni sees prices only while it runs: after it sleeps it reads the candles it missed, and something that happened meanwhile fires once, marked late, saying when. Stocks move only while their market trades. For news, posts or a mix of price and news, use another source.`;

/** The condition in plain words, for a fire's report. */
export function describe(condition: PriceCondition): string {
  return "crosses" in condition
    ? `${condition.market} crosses ${condition.crosses} ${condition.price}`
    : `${condition.market} moves ${condition.moves} ${condition.percent}% within ${condition.within}`;
}
