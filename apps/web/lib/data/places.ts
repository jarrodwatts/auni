import {
  startedChatWireSchema,
  threadWireSchema,
  type SpecialistId,
  type StartChatRequest,
  type ThreadId,
} from "@auni/shared";
import { z } from "zod";

import { chatHref, specialistHref } from "@/lib/app-links";
import { requestCore } from "@/lib/core";
import { toThread } from "@/lib/data/threads";
import type { Thread } from "@/lib/data/views";

/**
 * Each specialist has exactly one conversation; any other is a chat with Auni. A message goes to
 * the conversation it was typed in: one typed in a new chat starts that chat first.
 */

/** A place with a conversation: a specialist by its id, or a chat by its thread's. */
export type PlaceKey = SpecialistId | ThreadId;

export function threadPlace(thread: Pick<Thread, "id" | "specialistId">): PlaceKey {
  return thread.specialistId ?? thread.id;
}

export function threadHref(thread: Pick<Thread, "id" | "specialistId">): string {
  return thread.specialistId ? specialistHref(thread.specialistId) : chatHref(thread.id);
}

/** A new chat with Auni, titled by the first message the web then sends there. */
export async function startChat(text: string): Promise<Thread> {
  const body: StartChatRequest = { text };
  const { thread } = startedChatWireSchema.parse(
    await requestCore("places/chat", { method: "POST", body: JSON.stringify(body) }),
  );
  return toThread(thread);
}

/** A specialist's one thread, made the first time anyone asks for it. */
export async function getSpecialistThread(
  specialistId: SpecialistId,
  signal?: AbortSignal,
): Promise<Thread> {
  const body = z
    .object({ thread: threadWireSchema })
    .parse(await requestCore(`places/${specialistId}/thread`, { method: "POST", signal }));
  return toThread(body.thread);
}
