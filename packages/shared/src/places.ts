import { z } from "zod";

import { MAXIMUM_MESSAGE_CHARACTERS } from "./message.ts";
import { dollarsSchema } from "./money.ts";
import { modelSelectionSchema } from "./setup.ts";
import { threadActModeSchema, threadWireSchema } from "./thread.ts";

// A new thread with Auni: the web starts one with its first message's words (which title it)
// and any composer settings the owner picked (model, auto mode, budget), then sends that message.

/** The body `POST /places/chat` takes. */
export const startChatRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAXIMUM_MESSAGE_CHARACTERS),
  modelSelection: modelSelectionSchema.nullable().optional(),
  actMode: threadActModeSchema.optional(),
  budgetUsd: dollarsSchema.optional(),
});
export type StartChatRequest = z.infer<typeof startChatRequestSchema>;

/** What `POST /places/chat` answers. */
export const startedChatWireSchema = z.object({ thread: threadWireSchema });
