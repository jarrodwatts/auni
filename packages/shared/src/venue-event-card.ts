import { z } from "zod";

import { cardBaseSchema } from "./card-base.ts";
import { cardLogoUrlSchema } from "./specialist-proposal-card.ts";
import { actionRecordIdSchema } from "./shared.ts";

/**
 * Something a venue did to a position that core read from its statement
 * afterwards, posted into the chat of each specialist it touched: the venue
 * acting by itself, or a trade made outside Auni ("Hyperliquid closed your
 * STRK long"), or an order Auni placed earlier filling ("Your stop-loss
 * closed your STRK long"), or a market paying out by itself ("Polymarket paid
 * out $1 for ..."). Code writes every word.
 */
export const venueEventCardSchema = cardBaseSchema.extend({
  kind: z.literal("venue_event"),
  /** The move it is recorded under: Auni's own order, or the venue's record of what it did. */
  actionReference: actionRecordIdSchema,
  /** Whether no order of Auni's did it, which is what Auni asks them about. */
  outside: z.boolean(),
  /** Why, and what it came to or what filled: "Its price moved against it until the margin behind it ran out. You lost $5.26." */
  detail: z.string().trim().min(1).max(300),
  logoUrl: cardLogoUrlSchema.nullable(),
});
export type VenueEventCardWire = z.infer<typeof venueEventCardSchema>;
