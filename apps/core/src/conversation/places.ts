import { and, asc, desc, eq, exists, isNull, sql } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import { specialists, messages, threads, type ThreadRow } from "../db/schema.ts";
import { messageText } from "./history.ts";

/**
 * A specialist's one thread, created the first time anyone asks for it.
 * The partial unique index makes a concurrent second create a no-op, so
 * both callers end up with the same row. Undefined when there is no such
 * specialist.
 */
export async function specialistThread(
  specialistId: string,
  tx: Tx | typeof db = db,
): Promise<ThreadRow | undefined> {
  const existing = await findSpecialistThread(specialistId, tx);
  if (existing) return existing;
  const [specialist] = await tx
    .select({ name: specialists.name })
    .from(specialists)
    .where(eq(specialists.id, specialistId));
  if (!specialist) return undefined;
  const [created] = await tx
    .insert(threads)
    .values({ specialistId, title: specialist.name })
    .onConflictDoNothing()
    .returning();
  return created ?? findSpecialistThread(specialistId, tx);
}

async function findSpecialistThread(
  specialistId: string,
  tx: Tx | typeof db,
): Promise<ThreadRow | undefined> {
  const [row] = await tx.select().from(threads).where(eq(threads.specialistId, specialistId));
  return row;
}

const TITLE_CHARS = 48;

/** What Auni calls its main conversation when it starts one before any message. */
const MAIN_TITLE = "Auni";

/** A chat's title from its first message: its words, cut at a word near 48 characters. */
function chatTitle(text: string): string {
  const words = text.replace(/\s+/gu, " ").trim();
  if (words.length <= TITLE_CHARS) return words;
  const cut = words.slice(0, TITLE_CHARS + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > TITLE_CHARS / 2 ? space : TITLE_CHARS).trimEnd()}...`;
}

/** A new chat with Auni, outside every specialist, titled by its first message. */
export async function startChat(firstMessage: string): Promise<ThreadRow> {
  const [created] = await db
    .insert(threads)
    .values({ title: chatTitle(firstMessage) })
    .returning();
  if (!created) throw new Error("Failed to start the chat.");
  return created;
}

/**
 * Where to tell the owner of something that follows from a move of theirs: the chat the move was
 * made in, when it is one of the owner's own chats not archived, so the news sits beside what led
 * to it; else their main conversation (see mainChat).
 */
export async function chatOfMove(
  threadId: string | null,
  tx: Tx | typeof db,
): Promise<{ readonly id: string; readonly specialistId: string | null }> {
  if (threadId) {
    const [chat] = await tx
      .select({ id: threads.id, specialistId: threads.specialistId })
      .from(threads)
      .where(
        and(eq(threads.id, threadId), isNull(threads.specialistId), isNull(threads.archivedAt)),
      );
    if (chat) return chat;
  }
  return mainChat(tx);
}

/**
 * Auni's chat, where Auni speaks up unasked (news, the brief) and where a message from a channel
 * replying to nothing lands: the chat they were in last, outside every specialist, not archived,
 * and begun, which the web's sidebar names Auni (the one a person comes back to); or with none
 * yet, a new one. It may be about something else, so what lands there says where anything it
 * points to waits (see WRITE_IT in automations/brief.ts). A specialist's news stays in its own.
 */
export async function mainChat(
  tx: Tx | typeof db,
): Promise<{ readonly id: string; readonly specialistId: string | null }> {
  const [chat] = await tx
    .select({ id: threads.id, specialistId: threads.specialistId })
    .from(threads)
    .where(
      and(
        isNull(threads.specialistId),
        isNull(threads.archivedAt),
        exists(
          tx
            .select({ one: sql`1` })
            .from(messages)
            .where(eq(messages.threadId, threads.id)),
        ),
      ),
    )
    .orderBy(desc(threads.updatedAt))
    .limit(1);
  if (chat) return chat;
  const [created] = await tx
    .insert(threads)
    .values({ title: MAIN_TITLE })
    .returning({ id: threads.id, specialistId: threads.specialistId });
  if (!created) throw new Error("Failed to start the main conversation.");
  return created;
}

/**
 * Whether a chat still has the title Auni gave it as it began (its first message's words, or the
 * main conversation's name), rather than one the owner or the agent chose since.
 */
export async function titledByStart(thread: Pick<ThreadRow, "id" | "title">): Promise<boolean> {
  if (thread.title === MAIN_TITLE) return true;
  const [first] = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), eq(messages.role, "user")))
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return first !== undefined && thread.title === chatTitle(messageText(first.parts));
}

/** When the owner first sent Auni a message, or null before they have: the brief counts from it. */
export async function firstSpoke(tx: Tx | typeof db = db): Promise<Date | null> {
  const [first] = await tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(eq(messages.role, "user"))
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return first?.at ?? null;
}
