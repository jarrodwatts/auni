import {
  startedChatWireSchema,
  type ModelSelectionWire,
  type StartChatRequest,
  type ThreadActMode,
} from "@auni/shared";

import { chatHref } from "@/lib/app-links";
import { requestCore } from "@/lib/core";
import { toThread } from "@/lib/data/threads";
import type { Thread } from "@/lib/data/views";

/** Every conversation in Auni is a thread at `/app/chat/:id`. */

export function threadHref(thread: Pick<Thread, "id">): string {
  return chatHref(thread.id);
}

export interface StartChatOptions {
  readonly modelSelection?: ModelSelectionWire | null;
  readonly actMode?: ThreadActMode;
  readonly budgetUsd?: string;
}

/** A new thread with Auni, titled by the first message and optional starting settings. */
export async function startChat(text: string, options?: StartChatOptions): Promise<Thread> {
  const body: StartChatRequest = {
    text,
    ...(options?.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options?.actMode ? { actMode: options.actMode } : {}),
    ...(options?.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
  };
  const { thread } = startedChatWireSchema.parse(
    await requestCore("places/chat", { method: "POST", body: JSON.stringify(body) }),
  );
  return toThread(thread);
}
