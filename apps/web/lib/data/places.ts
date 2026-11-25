import {
  startedChatWireSchema,
  type ModelSelectionWire,
  type StartChatRequest,
  type ThreadId,
} from "@auni/shared";

import { chatHref } from "@/lib/app-links";
import { CoreApiError, requestCore } from "@/lib/core";
import { toThread } from "@/lib/data/threads";
import type { Thread } from "@/lib/data/views";

/** Every conversation in Auni is a thread at `/app/chat/:id`. */

export function threadHref(thread: Pick<Thread, "id">): string {
  return chatHref(thread.id);
}

export interface StartChatOptions {
  readonly modelSelection?: ModelSelectionWire | null;
}

/**
 * A new thread with Auni, made with its first message: titled by it, with any starting settings,
 * and that message's turn queued. A lost answer or a server fault may still have made it, so it's
 * asked for once more, which core makes once (the same ids); a refusal comes back at once.
 */
export async function startChat(
  start: { readonly id: ThreadId; readonly messageId: string; readonly text: string },
  options?: StartChatOptions,
): Promise<{ readonly thread: Thread; readonly keyKeptOut: boolean }> {
  const body: StartChatRequest = {
    id: start.id,
    messageId: start.messageId as StartChatRequest["messageId"],
    text: start.text,
    ...(options?.modelSelection ? { modelSelection: options.modelSelection } : {}),
  };
  const ask = () => requestCore("places/chat", { method: "POST", body: JSON.stringify(body) });
  const answer = await ask().catch((error: unknown) => {
    if (error instanceof CoreApiError && error.status < 500) throw error;
    return ask();
  });
  const { thread, keyKeptOut } = startedChatWireSchema.parse(answer);
  return { thread: toThread(thread), keyKeptOut: keyKeptOut === true };
}
