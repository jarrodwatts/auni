import { cardLogoUrlSchema, timestampSchema } from "@auni/shared";
import { z } from "zod";

// What Elfa's card, the tape (tape.card.tsx), is handed: plain data core builds (pulse.ts) and
// the web parses with this schema before it draws anything.

/** Which way a story leans for what it names, as Elfa reads it. */
export const storyImplicationSchema = z.enum(["bullish", "bearish", "mixed", "unclear"]);

/** One post behind a story. Only X posts link, and a Telegram name is not an X handle. */
const storySourceSchema = z.strictObject({
  platform: z.enum(["x", "telegram", "other"]),
  handle: z.string().trim().min(1).max(100).nullable(),
  link: z
    .url({ protocol: /^https$/ })
    .max(500)
    .nullable(),
});

/** One story Elfa wrote up from many people's posts: their words, shown as they are. */
const pulseStorySchema = z.strictObject({
  /** Elfa's event id. */
  id: z.string().min(1).max(100),
  /** When Elfa wrote it up. */
  at: timestampSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(1_000).nullable(),
  implication: storyImplicationSchema.nullable(),
  /** `alert`: judged impactful. `monitor`: worth watching. */
  weight: z.enum(["alert", "monitor"]),
  /** Distinct accounts behind it; `sources` lists at most ten of their posts. */
  sourceCount: z.int().min(0),
  sources: z.array(storySourceSchema).max(10),
  /** How the asset moved over the day from the story's first post, in percent; null until measured. */
  reactionPct: z.number().nullable(),
});

/**
 * "The tape": one asset's last seven days, its price line with the stories Elfa wrote up pinned
 * where they landed, and the agent's own read of it. Built once when the agent calls
 * market_pulse and never refreshed: it shows the week as it was then.
 */
const tapeSchema = z.strictObject({
  asset: z.strictObject({
    name: z.string().trim().min(1).max(120),
    symbol: z.string().trim().min(1).max(24).nullable(),
    logoUrl: cardLogoUrlSchema.nullable(),
  }),
  /** Dollars over the last seven days, oldest first; null when nothing prices it. */
  price: z
    .strictObject({
      now: z.number().positive(),
      weekChangePct: z.number(),
      points: z
        .array(z.strictObject({ at: timestampSchema, value: z.number() }))
        .min(2)
        .max(500),
    })
    .nullable(),
  /** The week's stories, oldest first. Empty when nothing was written up. */
  stories: z.array(pulseStorySchema).max(12),
  /**
   * The stories written on the chart beside their bead, by id: the agent's picks,
   * or the week's biggest moves when it picked none. A label is the agent's short
   * title for it; without one the story's own title shows.
   */
  highlights: z
    .array(
      z.strictObject({
        storyId: z.string().min(1).max(100),
        label: z.string().trim().min(1).max(48).nullable(),
      }),
    )
    .max(2),
  /**
   * Open long and short positions tracked accounts hold on it now; null when
   * Elfa can't say. For the agent to read: the card itself doesn't draw it.
   */
  positioning: z.strictObject({ long: z.int().min(0), short: z.int().min(0) }).nullable(),
  /** The agent's own one or two sentences, shown as "What Auni thinks". */
  take: z.string().trim().min(1).max(400),
});
export type Tape = z.infer<typeof tapeSchema>;

export default tapeSchema;
