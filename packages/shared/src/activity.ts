import { z } from "zod";

import { cardLogoUrlSchema } from "./action-card.ts";
import { dollarsSchema } from "./money.ts";
import { threadIdSchema, timestampSchema } from "./shared.ts";

/** Green for money in or a gain, red for a loss, plain otherwise. */
const toneSchema = z.enum(["gain", "loss", "neutral"]);

/**
 * What an item moved, as its row shows it on the right. Only money in or out
 * and a result locked in carry a direction; a buy's amount is plain.
 */
const activityAmountSchema = z.object({
  usd: dollarsSchema,
  /** "+" for money in, "−" for money out; null for an amount that is neither, like a buy. */
  direction: z.enum(["in", "out"]).nullable(),
  tone: toneSchema,
});

/**
 * What an item is about, as its row wears it: the coin or asset's picture, and what it is
 * called, whose initials stand in when it has no picture the web can draw.
 */
const activityLogoSchema = z.object({
  src: cardLogoUrlSchema.nullable(),
  /** "Tether Gold", "USDC". */
  name: z.string().min(1).max(60),
});

const activityBaseSchema = z.object({
  id: z.string(),
  /** In plain words: "Bought Pearl", "Closed Meta, bought Micron", "Money arrived". */
  title: z.string(),
  /** Where and when: "Peptides, Oct 14 at 8:21pm"; "Auni" for a move outside a named thread. */
  subtitle: z.string(),
  amount: activityAmountSchema.nullable(),
  /** The thread it belongs to; null for wallet arrivals or moves outside a thread. */
  threadId: threadIdSchema.nullable(),
  /** What it is about; null for none (Auni's own mark). */
  logo: activityLogoSchema.nullable(),
  /** When it happened. */
  at: timestampSchema,
  /** Something they didn't do, recorded since they last looked at their activity. */
  unread: z.boolean(),
});

/** One line of how Auni did a move: "Moved cash to Hyperliquid", "$35". */
const activityStepSchema = z.object({
  text: z.string(),
  amountUsd: dollarsSchema.nullable(),
  logoUrl: cardLogoUrlSchema.nullable(),
});

/**
 * One side of a move, on a tile: what left or what arrived, and where: "You paid", "3 USDC", on
 * "Monad"; or what a position did: "You closed", "$10.47 short at 3x", then "It lost", "$0.01".
 */
const storySideSchema = z.object({
  label: z.string(),
  value: z.string(),
  place: z.string().nullable(),
  tone: toneSchema,
});

/**
 * A price on one line of prices: where a position was entered or closed, or the market's price
 * when the move was made ("price"), or where a stop waits to close it ("stop").
 */
const storyLevelSchema = z.object({
  /** "Entered at", "Stop-loss". */
  label: z.string(),
  /** "$3,320.50". */
  price: z.string(),
  kind: z.enum(["price", "stop"]),
});

/**
 * What one move did, as a small true story from its record: what left and what arrived (or what
 * a position did and what that made or lost), the prices it moved between, a few facts (its
 * price, the services it went through), and where to see it on its chain. Each part is absent
 * where the record doesn't hold it.
 */
const activityStorySchema = z.object({
  gave: storySideSchema.nullable(),
  got: storySideSchema.nullable(),
  /** Its prices on one line, highest first, so a short's stop-loss sits above where it was entered. */
  levels: z.array(storyLevelSchema).max(4),
  /** Label over value: "Price", "$3,871.20 per XAUt0"; "Through", "KyberSwap, filled on Kuru". */
  facts: z.array(z.object({ label: z.string(), value: z.string() })).max(4),
  /** Its transactions on their chains' explorers: "Monadscan". */
  links: z.array(z.object({ label: z.string(), url: z.url({ protocol: /^https$/u }) })).max(4),
});

/**
 * One thing that happened to their money, as a person thinks of it: a move
 * of Auni's with every leg of its card folded in, something a venue did by
 * itself, or money that arrived or left without Auni.
 */
export const activityItemWireSchema = z.discriminatedUnion("kind", [
  activityBaseSchema.extend({
    kind: z.literal("move"),
    receipt: z.object({
      /** What it did, in the order it ran, at most four lines. */
      steps: z.array(activityStepSchema).max(4),
      /** A move of one step, told whole (see activityStorySchema); null for one of several. */
      story: activityStorySchema.nullable(),
    }),
  }),
  activityBaseSchema.extend({
    kind: z.literal("outside"),
    /**
     * Whether it leaves them something to decide, as Hyperliquid closing a
     * position does and Polymarket paying out doesn't: drawn in the loss
     * color, with a way to ask Auni what now.
     */
    decision: z.boolean(),
    receipt: z.object({
      /** Who did it, as people know them: "Hyperliquid". */
      by: z.string(),
      /** The position before and after, in the venue's numbers: "193.1 STRK long, $15.17", "Closed". */
      before: z.string(),
      after: z.string(),
      /** Why it happened, in one sentence code wrote. */
      why: z.string(),
    }),
  }),
  activityBaseSchema.extend({
    kind: z.literal("arrival"),
    receipt: z.object({
      /** As people read it: "Base". */
      network: z.string(),
      moved: z.array(z.object({ amount: z.string(), symbol: z.string() })).min(1),
      /** Who was on the other side, shortened: who sent money in, or where money out went. */
      counterparty: z.string().nullable(),
    }),
  }),
]);
export type ActivityItemWire = z.infer<typeof activityItemWireSchema>;

/** GET /activity: newest first, and how many of everything they have are unread. */
export const activityWireSchema = z.object({
  items: z.array(activityItemWireSchema),
  unread: z.int().min(0),
});
export type ActivityWire = z.infer<typeof activityWireSchema>;
export type ActivityStoryWire = z.infer<typeof activityStorySchema>;
