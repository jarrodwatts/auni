import { z } from "zod";

import { dollarsSchema } from "./money.ts";
import { timestampSchema } from "./shared.ts";

/**
 * How far back a chart looks, as `?range=` asks for it. Today runs from the
 * person's own midnight (their browser's time zone) with a point every 15
 * minutes, and 1W with one every hour, both from readings moved by what
 * prices did between them; 1M and longer are the readings themselves, the
 * last of each day.
 */
export const valueRangeSchema = z.enum(["Today", "1W", "1M", "3M", "1Y", "All"]);
export type ValueRange = z.infer<typeof valueRangeSchema>;

/**
 * A value over one range, oldest first: the whole account on GET
 * /portfolio/history, one specialist on GET /specialists/:id/history.
 */
export const valueHistoryWireSchema = z.object({
  /** When its first reading with money in it was taken, so only ranges it covers are offered; null if none was. */
  startedAt: timestampSchema.nullable(),
  points: z.array(
    z.object({
      takenAt: timestampSchema,
      usdValue: dollarsSchema,
      /**
       * Signed: what it had made by then, net of money added or taken out, so
       * a move over a range is the end's less the start's.
       */
      madeUsd: dollarsSchema,
    }),
  ),
});
export type ValueHistoryWire = z.infer<typeof valueHistoryWireSchema>;
