import { z } from "zod";

/**
 * What a pick on a proposal card shows when opened: how its price (or a
 * prediction's chance of Yes) has moved, and the few numbers that matter for
 * that kind of asset, in plain words.
 */
export const pickDetailWireSchema = z.object({
  /** A price in dollars, or a chance of Yes from 0 to 1. */
  kind: z.enum(["price", "chance"]),
  /** What it is and where it trades: "Stock, trades 24/7". */
  label: z.string(),
  now: z.number(),
  /** Change over the last day: percent for a price, points for a chance. */
  today: z.number().nullable(),
  /** Daily readings over about three months, oldest first. */
  points: z.array(z.object({ at: z.string(), value: z.number() })),
  facts: z.array(z.object({ label: z.string(), value: z.string() })).max(4),
  /**
   * A leveraged position's prices: where it takes profit, where its stop
   * sells, and where it's wiped out. Only those that exist, read from the
   * position once it's open, or from the order before that.
   */
  levels: z
    .array(z.object({ kind: z.enum(["take_profit", "stop", "liquidation"]), price: z.number() }))
    .max(3)
    .default([]),
});
export type PickDetailWire = z.infer<typeof pickDetailWireSchema>;
