import {
  messageWireSchema,
  threadIdSchema,
  threadSearchResultWireSchema,
  threadStateWireSchema,
  threadWireSchema,
  type SendMessageRequest,
  type ThreadId,
  type ThreadStreamEvent as StreamEvent,
  type ThreadWire,
  type UpdateThreadRequest,
} from "@auni/shared";
import type { UIMessageChunk } from "ai";
import { z } from "zod";

import { requestCore } from "@/lib/core";
import { toAuniMetadata, type AuniUiMessage } from "@/lib/conversation";
import { listenLive } from "@/lib/data/live";
import { toHolding } from "@/lib/data/portfolio";
import type { Thread, ThreadSearchResult, ThreadState } from "@/lib/data/views";

/**
 * Threads and messages come from core, and so does everything live, over the tab's one stream
 * (lib/data/live.ts). Every conversation is a thread.
 */

export function toThread(wire: ThreadWire): Thread {
  return {
    id: wire.id,
    title: wire.title?.trim() || "New conversation",
    state: wire.status === "idle" ? "done" : wire.status,
    moneyLine: wire.moneyLine,
    asking: wire.asking,
    unread: wire.unread,
    moving: wire.moving,
    actMode: wire.actMode,
    budgetUsd: wire.budgetUsd,
    notes: wire.notes,
    modelSelection: wire.modelSelection,
    pinned: wire.pinnedAt !== null,
    pinnedAt: wire.pinnedAt,
    watchCount: wire.watchCount,
    moveCount: wire.moveCount,
    archived: wire.archivedAt !== null,
    createdAt: wire.createdAt,
    updatedAt: wire.lastActivityAt,
  };
}

const threadsResponseSchema = z.object({ threads: z.array(threadWireSchema) });
const threadResponseSchema = z.object({ thread: threadWireSchema });

export async function listThreads(): Promise<readonly Thread[]> {
  return threadsResponseSchema
    .parse(await requestCore("threads", { method: "GET" }))
    .threads.map(toThread);
}

/** Live budget headroom and holdings opened in one thread (`GET /threads/:id/state`). */
export async function getThreadState(
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ThreadState> {
  const body = threadStateWireSchema.parse(
    await requestCore(`threads/${threadId}/state`, { method: "GET", signal }),
  );
  return {
    budgetUsd: body.budgetUsd,
    freeBudgetUsd: body.freeBudgetUsd,
    holdings: body.holdings.map(toHolding),
  };
}

/** Updates a thread's title, pin, archive, autonomy budget, or model selection. */
export async function updateThread(
  threadId: ThreadId,
  change: UpdateThreadRequest,
): Promise<Thread> {
  const body = threadResponseSchema.parse(
    await requestCore(`threads/${threadId}`, { method: "PATCH", body: JSON.stringify(change) }),
  );
  return toThread(body.thread);
}

/** Deletes a thread for good; core may refuse, saying why (`detail`). */
export async function deleteThread(threadId: ThreadId): Promise<void> {
  await requestCore(`threads/${threadId}`, { method: "DELETE" });
}

/** Says the person has seen the thread's newest answer, so every device stops calling it unread. */
export async function markThreadRead(threadId: ThreadId): Promise<void> {
  await requestCore(`threads/${threadId}/read`, { method: "POST" });
}

/** A thread's stored messages, and whether core has a turn of it queued or running. */
export async function listThreadMessages(
  threadId: ThreadId,
): Promise<{ readonly messages: readonly AuniUiMessage[]; readonly running: boolean }> {
  const body = await requestCore(`threads/${threadId}/messages`, { method: "GET" });
  const { messages, running } = z
    .object({ messages: z.array(messageWireSchema), running: z.boolean() })
    .parse(body);
  return { messages: messages.map(toUiMessage), running };
}

/** A stored message as the transcript draws it. */
function toUiMessage(message: z.infer<typeof messageWireSchema>): AuniUiMessage {
  return {
    id: message.id,
    role: message.role,
    // Core stores the same UI message parts it streamed.
    parts: message.parts as AuniUiMessage["parts"],
    metadata: toAuniMetadata(message.metadata),
  };
}

export async function searchThreads(
  query: string,
  signal?: AbortSignal,
): Promise<readonly ThreadSearchResult[]> {
  const body = await requestCore(`threads/search?q=${encodeURIComponent(query)}`, {
    method: "GET",
    signal,
  });
  const { results } = z.object({ results: z.array(threadSearchResultWireSchema) }).parse(body);
  return results.map((result) => ({ ...result, thread: toThread(result.thread) }));
}

type ThreadStreamEvent = StreamEvent<UIMessageChunk>;

/**
 * A thread's turns for as long as it is watched, including the ones core starts on its own.
 * `open()` settles once the stream is open now (lib/data/live.ts).
 */
export function watchThread(
  threadId: ThreadId,
  onEvent: (event: ThreadStreamEvent) => void,
  onGap: () => void,
): ReturnType<typeof listenLive> {
  return listenLive((message) => {
    if (message.topic === "thread" && message.threadId === threadId) onEvent(message.event);
  }, onGap);
}

/** Every change to the person's sidebar rows, live: a row as it is now, or one deleted. */
export function watchThreadRows(
  onThread: (thread: Thread) => void,
  onGone: (threadId: ThreadId) => void,
  onGap: () => void,
): () => void {
  return listenLive((message) => {
    if (message.topic === "row") onThread(toThread(threadWireSchema.parse(message.thread)));
    if (message.topic === "gone") onGone(threadIdSchema.parse(message.threadId));
  }, onGap).close;
}

/**
 * Sends the person's message; core answers at once and the turn streams over `/live`. Core keeps
 * out a message that holds a private key: nothing of it is stored and no turn answers it, and
 * Auni's own answer is posted in its place. True for one kept out.
 */
export async function sendThreadMessage(
  threadId: ThreadId,
  message: SendMessageRequest,
): Promise<boolean> {
  const answer = await requestCore(`threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify(message),
  });
  return typeof answer === "object" && answer !== null && "keyKeptOut" in answer;
}

export function stopThread(threadId: ThreadId): Promise<unknown> {
  return requestCore(`threads/${threadId}/stop`, { method: "POST" }).catch(() => undefined);
}
