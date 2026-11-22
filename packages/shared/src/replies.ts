import { z } from "zod";

import { textAsMeant } from "./tool-input.ts";

/** One answer to Auni's question: what it reads as, and what choosing it means. */
const replyOptionSchema = z.object({
  label: z.string().trim().min(1).max(40),
  hint: z.string().trim().min(1).max(60).optional(),
});
export type ReplyOption = z.infer<typeof replyOptionSchema>;

/**
 * suggest_replies' input: a question the web docks above the reply box as a picker. With no
 * question the options are the next things the owner might say, the likeliest first, and they
 * dock as one row of buttons; one is enough then.
 */
export const suggestRepliesInputSchema = z.object({
  question: z.string().trim().min(1).max(240).optional(),
  options: z.array(replyOptionSchema).min(1).max(4),
  /** Several answers can be picked together. */
  multiple: z.boolean().optional(),
});

/**
 * A stored call's input, as the agent sent it, read as the tool read it (textAsMeant), and
 * leniently: options were plain strings before they carried hints.
 */
export const storedSuggestRepliesSchema = textAsMeant(
  z.object({
    question: z.string().min(1).optional(),
    options: z
      .array(z.union([z.string().transform((label) => ({ label })), replyOptionSchema]))
      .min(1),
    multiple: z.boolean().optional(),
  }),
);
