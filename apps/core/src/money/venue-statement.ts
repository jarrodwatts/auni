import type { VenueToolName } from "@auni/shared";
import { z } from "zod";

import type { Fill } from "./recipe.ts";

/**
 * A venue's statement as the venue gives it: its account's own record of what
 * traded there, read into entries. Core records them the same for every venue
 * (see statements.ts), so a venue app needs only these types.
 */

/** One line of a statement: a trade, as the venue recorded it. */
export interface StatementFill extends Fill {
  /** The line, named uniquely across every account: "<venue>:<address>:<trade id>". */
  readonly ref: string;
  /** When the venue made it. */
  readonly at: Date;
  /** The position just before it, signed as books are (a short below zero), in QUANTITY_DECIMALS units. */
  readonly before: bigint;
  /** What it locked in, signed, in dollars: 0 for a line that closes nothing (see fills.pnlUsd). */
  readonly pnlUsd?: string;
}

/**
 * What lines that happened together did to one position, in the venue's own
 * numbers, as decimal strings: what an outside action keeps as its details,
 * and what the person is told (see tellStatement).
 */
export const happenedSchema = z.object({
  /** Which order of Auni's did it (see orderOf), or what no order of Auni's did. */
  cause: z.enum(["limit", "exit", "liquidation", "auto-deleveraging", "trade"]),
  /** As the venue names it: "STRK", "xyz:NVDA". */
  market: z.string(),
  side: z.enum(["buy", "sell"]),
  size: z.string(),
  priceUsd: z.string(),
  /** The position just before and after, signed: a short below zero. */
  before: z.string(),
  after: z.string(),
  /** What it locked in, signed. */
  closedPnlUsd: z.string(),
  /** All the venue charged, a builder's fee included. */
  venueFeeUsd: z.string(),
});
export type Happened = z.infer<typeof happenedSchema>;

/** A stop a move set, by what it is for: never guessed from what it made. */
export type Exit = "stop-loss" | "take-profit";

/**
 * Which of a move's orders a fill of it is, from which way the move opens a position:
 * its entry, which fills later only as a limit left resting, when the fill trades the way the
 * move opens; else a stop-loss or take-profit the move set. A move that opens no position has
 * only exits. The one place it is decided, for chat and activity alike.
 */
export function orderOf(
  opens: "long" | "short" | null,
  side: "buy" | "sell",
): Extract<Happened["cause"], "limit" | "exit"> {
  return opens !== null && (opens === "long") === (side === "buy") ? "limit" : "exit";
}

/** Lines that happened together, what they did, and who did them. */
export type StatementEntry = {
  readonly fills: readonly StatementFill[];
  readonly happened: Happened;
} & (
  | {
      /** The action whose order made them, by the tag it carried. */
      readonly actionId: string;
      /** Which of the move's stops it was, when it was one and the venue can tell. */
      readonly exit?: Exit;
      /**
       * What the fill leaves for the owner to decide, in a sentence for them: something the
       * move's card showed that is not in place, such as its stops. It is said on the news of
       * the fill, and the thread is woken for it.
       */
      readonly unfinished?: string;
    }
  | {
      /** What no order of Auni's did, as its done action says it, in code's words. */
      readonly summary: string;
    }
);

/** One account's statement on one venue; core files it under the venue's app id. */
export interface Statement {
  /** The tool what Auni didn't do is recorded under. */
  readonly tool: VenueToolName;
  /**
   * Its entries after `since` (a time in milliseconds), or on a first read
   * (null) those of its history it can tell apart, oldest first; and the
   * time through which every line has been read, which the next read goes on
   * from.
   */
  read(since: number | null): Promise<{ entries: StatementEntry[]; through: number }>;
}
