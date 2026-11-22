import type { LiveMessage as Live, ThreadStreamEvent as StreamEvent } from "@auni/shared";
import type { UIMessageChunk } from "ai";

import type { ThreadWire } from "./threads.ts";

type ThreadStreamEvent = StreamEvent<UIMessageChunk>;
export type LiveMessage = Live<UIMessageChunk, ThreadWire>;

// Core is one process, so everything that publishes and every open tab's stream (routes/live.ts)
// meet here, in memory.
const listeners = new Set<(message: LiveMessage) => void>();

/** Hears every live message until the returned function is called. */
export function onLive(listener: (message: LiveMessage) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit(message: LiveMessage): void {
  for (const listener of listeners) {
    // A live view that fails costs that view only, never the turn or move that published.
    try {
      listener(message);
    } catch (error) {
      console.error("live publish failed", error);
    }
  }
}

/** A thread's turn moved on: progress, its chunks in order, its end, or a card core posted. */
export function publishThreadEvent(threadId: string, event: ThreadStreamEvent): void {
  emit({ topic: "thread", threadId, event });
}

/** A thread's row as it is now (see publishThread in threads.ts, which reads it). */
export function publishThreadRow(thread: ThreadWire): void {
  emit({ topic: "row", thread });
}

/** A thread the owner deleted, so every open tab drops its row. */
export function publishThreadGone(threadId: string): void {
  emit({ topic: "gone", threadId });
}

/** What Auni is doing to make a brain ready moved on (agent/sign-in.ts), so each tab reads it again. */
export function publishBrains(): void {
  emit({ topic: "brains" });
}

/** The owner's settings or profile changed, so open tabs refresh `/me` and apply synced theme changes. */
export function publishMe(): void {
  emit({ topic: "me" });
}

/** Fresh tailored starting points were saved, so open new-chat screens update immediately. */
export function publishStartingPoints(): void {
  emit({ topic: "starting-points" });
}
