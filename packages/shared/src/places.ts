import { z } from "zod";

import { MAXIMUM_MESSAGE_CHARACTERS } from "./message.ts";
import { threadWireSchema } from "./thread.ts";

// A new chat with Auni: the web starts one with its first message's words (which title it), then
// sends that message there like any other. A specialist begins only from the owner's tap on a
// start card, never from a message.

/** The body `POST /places/chat` takes. */
export const startChatRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAXIMUM_MESSAGE_CHARACTERS),
});
export type StartChatRequest = z.infer<typeof startChatRequestSchema>;

/** What `POST /places/chat` answers. */
export const startedChatWireSchema = z.object({ thread: threadWireSchema });
