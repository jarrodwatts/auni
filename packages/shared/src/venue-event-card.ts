import { z } from "zod";

import { cardLogoUrlSchema } from "./action-card.ts";
import { cardBaseSchema } from "./card-base.ts";
import { actionRecordIdSchema } from "./shared.ts";

/**
 * Something a venue did to a position that core read from its statement
 * afterwards, posted into the thread that opened it (or the latest thread):
 * the venue acting by itself, or a trade made outside Auni ("Hyperliquid closed
 * your STRK long"), or an order Auni placed earlier filling ("Your stop-loss
 * closed your STRK long"), or a market paying out by itself.
 */
export const venueEventCardSchema = cardBaseSchema.extend({
  kind: z.literal("venue_event"),
  /** The move it is recorded under: Auni's own order, or the venue's record of what it did. */
  actionReference: actionRecordIdSchema,
  /** Whether no order of Auni's did it, which is what Auni asks them about. */
  outside: z.boolean(),
  /** Why, or what filled when it locked in nothing: "Its price moved against it until the margin behind it ran out." */
  detail: z.string().trim().min(1).max(300),
  /**
   * What it locked in, in signed dollars ("-76.51", "12.00"): the card says it as a gain or a
   * loss beside its title. Absent when it locked in nothing.
   */
  pnlUsd: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/u)
    .nullable()
    .optional(),
  logoUrl: cardLogoUrlSchema.nullable(),
});
export type VenueEventCardWire = z.infer<typeof venueEventCardSchema>;
