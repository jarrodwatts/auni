import { and, isNotNull, ne } from "drizzle-orm";

import { arrivals } from "../db/schema.ts";
import type { ArrivalKind } from "./arrivals.ts";
import { signedUsdToCents } from "./usd.ts";

// Which money moved is told to the owner (see news.ts), wherever it shows or counts.

type ArrivalRow = typeof arrivals.$inferSelect;

/** Money in from outside, which arrives on a card. */
export const IN: readonly ArrivalKind[] = ["deposit", "payout"];
/** Everything told: money in, and money out that Auni didn't send. */
export const TOLD: readonly ArrivalKind[] = [...IN, "external_out"];

/**
 * Whether an arrival is told, wherever it shows: a cent or more either way,
 * the least the app shows. Only a token that is theirs or that Auni
 * recognises is recorded at all (see recordArrivals and buckets.ts), so what
 * anyone can mint and price from a pool they seeded never gets this far; a
 * token with no price is worth nothing Auni can say.
 */
export function told(row: Pick<ArrivalRow, "usdValue">): boolean {
  return row.usdValue !== null && signedUsdToCents(row.usdValue) !== 0n;
}

/** The same rule in SQL, for a read that picks what's told from many. */
export const TOLD_SQL = and(isNotNull(arrivals.usdValue), ne(arrivals.usdValue, "0"))!;
