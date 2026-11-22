import { z } from "zod";

import { messageIdSchema } from "./shared.ts";

export const MAXIMUM_MESSAGE_CHARACTERS = 8_000;

/** The body `POST /threads/:id/messages` takes. */
export const sendMessageRequestSchema = z.object({
  /** The browser's id for the message, which the turn's stream answers to. */
  id: messageIdSchema,
  text: z.string().trim().min(1).max(MAXIMUM_MESSAGE_CHARACTERS),
  /** An edit or a regenerate: the earlier user message this one replaces. */
  supersedesId: messageIdSchema.optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
