import { and, eq, sql } from "drizzle-orm";

import { usedChannel } from "../channels/home.ts";
import { db } from "../db/client.ts";
import { messages, threads, type ThreadRow } from "../db/schema.ts";
import { turnKind } from "../jobs/kinds.ts";
import { keepKeyOut, pastedKey } from "./pasted-key.ts";
import { stopTurn } from "./stop.ts";
import { publishThread } from "./threads.ts";

interface OwnerMessage {
  /** Chosen by the sender, so a retried send stores it once and queues one turn. */
  readonly id: string;
  readonly text: string;
  /** The owner's earlier message this one replaces (an edit). */
  readonly supersedesId?: string;
  /** The channel app it came from; unset, the web app. */
  readonly channel?: string;
}

/**
 * What became of a message: stored with its turn queued, kept out for the private key it held
 * (pasted-key.ts), or refused, as an edit of a message that isn't the owner's in this thread.
 */
type Sent = "sent" | "key_kept_out" | "not_theirs";

/**
 * Stores a message from the owner in a thread and queues the turn that answers it, from the web
 * app or any channel alike, unless it holds a private key: then nothing of it is stored or read
 * by the agent, and Auni answers in its place.
 */
export async function sendMessage(thread: ThreadRow, message: OwnerMessage): Promise<Sent> {
  const { id, text, supersedesId, channel } = message;

  if (supersedesId) {
    const [replaced] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, supersedesId),
          eq(messages.threadId, thread.id),
          eq(messages.role, "user"),
        ),
      );
    if (!replaced) return "not_theirs";
  }

  const key = await pastedKey(text);
  if (key) {
    await keepKeyOut(thread, { id, ...(channel ? { channel } : {}) }, key);
    return "key_kept_out";
  }

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        id,
        threadId: thread.id,
        role: "user",
        parts: [{ type: "text", text }],
        supersedesId: supersedesId ?? null,
        metadata: channel ? { channel } : {},
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    if (row) {
      // Replying to an archived chat brings it back into the list; replying reads it. The thread
      // shows a turn coming from now, unless one runs: its marker is its turn token's, which a
      // new message must never take away (conversation/turn.ts).
      await tx
        .update(threads)
        .set({
          turnStartedAt: sql`coalesce(${threads.turnStartedAt}, now())`,
          updatedAt: sql`now()`,
          archivedAt: null,
          readAt: sql`now()`,
        })
        .where(eq(threads.id, thread.id));
      // Where they last talked to Auni is where background answers follow them (channels/home.ts).
      await usedChannel(tx, channel ?? null);
      // The message id is the turn's key, so a message is answered once, and always: a stored
      // message has its turn queued with it.
      await turnKind.enqueue(tx, { threadId: thread.id, messageId: id }, { key: id });
    }
    return row ? "stored" : "duplicate";
  });
  // A retried send: its first try stored it and queued its turn.
  if (outcome === "duplicate") return "sent";

  void publishThread(thread.id);
  // A new message waits for a turn still running, and is answered next, from any app: what the
  // owner asked before it is still answered. An edit is different: the turn answering the words
  // it replaces stops, as they were taken back.
  if (supersedesId) stopTurn(thread.id, supersedesId);
  return "sent";
}
