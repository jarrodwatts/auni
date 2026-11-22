import type { Status } from "@/components/motion/status-mark";
import type { Specialist, Thread } from "@/lib/data/views";

/**
 * What a place's dot says: a card or a question waits on the person, or Auni
 * answered since they last looked. Null when there's nothing new.
 */
export type PlaceAttention = "waiting" | "unread" | null;

/**
 * A place's dot, from its thread. A closed specialist's question waits on no
 * one, as closing it answered whatever it asked; a card there still would.
 */
export function attentionOf(
  thread: Thread | undefined,
  specialist?: Pick<Specialist, "status">,
): PlaceAttention {
  if (!thread || thread.state === "running") return null;
  const asks = thread.asking && specialist?.status !== "retired";
  if (thread.state === "needs_user" || asks) return "waiting";
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

/** What trails a chat's title: your turn, in words, or the ring of its money. */
export type ChatMark =
  { readonly kind: "turn" } | ({ readonly kind: "money" } & MoneyProgress) | null;

/** How a chat's row reads: do I need to look, and is anything happening. */
export interface ChatStatus {
  /** Auni is writing in it: its title shimmers. */
  readonly working: boolean;
  /** Auni answered since the person last looked: its title is heavier. */
  readonly unread: boolean;
  readonly mark: ChatMark;
}

/**
 * A chat's row, from its thread. Something waiting on the person outranks
 * money already on its way, which needs nothing from them.
 */
export function chatStatus(thread: Thread): ChatStatus {
  const money = moneyProgress(thread.moving);
  return {
    working: thread.state === "running",
    unread: thread.unread,
    mark:
      attentionOf(thread) === "waiting"
        ? { kind: "turn" }
        : money
          ? { kind: "money", ...money }
          : null,
  };
}
