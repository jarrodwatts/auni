import type { Status } from "@/components/motion/status-mark";
import type { Thread } from "@/lib/data/views";

/**
 * What a thread's dot says: a card or a question waits on the person, or Auni
 * answered since they last looked. Null when there's nothing new.
 */
export type PlaceAttention = "waiting" | "unread" | null;

export function attentionOf(thread: Thread | undefined): PlaceAttention {
  if (!thread) return null;
  // A card waits on the person even while Auni writes (a held order wakes it to say so); core
  // calls a question asked only once the answer is done.
  if (thread.moneyLine || thread.asking) return "waiting";
  return thread.unread ? "unread" : null;
}

/**
 * Money moving in a thread, as its ring shows it: legs through of all of them,
 * and whether it is still going, all went through, or some didn't.
 */
export interface MoneyProgress {
  readonly done: number;
  readonly total: number;
  readonly status: Extract<Status, "now" | "done" | "failed">;
}

export function moneyProgress(moving: Thread["moving"]): MoneyProgress | null {
  if (!moving) return null;
  const { done, failed, total } = moving;
  const status = done + failed < total ? "now" : failed > 0 ? "failed" : "done";
  return { done, total, status };
}

/** How a thread's row reads: do I need to look, and is anything happening. */
export interface ChatStatus {
  /** Auni is writing in it: its title shimmers. */
  readonly working: boolean;
  /** Auni answered since the person last looked: its title is heavier. */
  readonly unread: boolean;
  /** Its money's ring, while that moves and until how it went is read. */
  readonly money: MoneyProgress | null;
}

/** A thread's row, from its live state. Whether it waits on the person is its group's to say. */
export function chatStatus(thread: Thread): ChatStatus {
  return {
    working: thread.state === "running",
    unread: thread.unread,
    money: moneyProgress(thread.moving),
  };
}
