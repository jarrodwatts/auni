import { z } from "zod";

import { MAXIMUM_MESSAGE_CHARACTERS } from "./message.ts";
import { dollarsSchema } from "./money.ts";
import { modelSelectionSchema } from "./setup.ts";
import { messageIdSchema, threadIdSchema } from "./shared.ts";
import { threadActModeSchema, threadWireSchema } from "./thread.ts";

// A new thread with Auni, made with its first message: its words (which title it) and any
// composer settings the owner picked (model, auto mode, budget). Core stores the thread and the
// message together, so a chat is never there without the words that started it.

/** The body `POST /places/chat` takes. */
export const startChatRequestSchema = z.object({
  /**
   * Chosen by the web, so it hears the thread's first turn from before core makes it, and a
   * retried start makes it once.
   */
  id: threadIdSchema,
  /** The first message's id, as a send's (see sendMessageRequestSchema). */
  messageId: messageIdSchema,
  text: z.string().trim().min(1).max(MAXIMUM_MESSAGE_CHARACTERS),
  modelSelection: modelSelectionSchema.nullable().optional(),
  actMode: threadActModeSchema.optional(),
  budgetUsd: dollarsSchema.optional(),
});
export type StartChatRequest = z.infer<typeof startChatRequestSchema>;

/**
 * What `POST /places/chat` answers. `keyKeptOut`: the first message held a private key, so, as
 * for any send, nothing of it was kept and Auni's answer stands in its place.
 */
export const startedChatWireSchema = z.object({
  thread: threadWireSchema,
  keyKeptOut: z.literal(true).optional(),
});
