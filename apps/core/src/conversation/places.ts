import type { ModelSelectionWire, ThreadActMode } from "@auni/shared";
import { and, asc, desc, eq, exists, isNull, sql } from "drizzle-orm";

import { lockOwner } from "../auth/owner.ts";
import { db, type Tx } from "../db/client.ts";
import { messages, owner, threads, type ThreadRow } from "../db/schema.ts";
import { refreshStartingPoints } from "../jobs/kinds.ts";
import { normalizeUsd } from "../money/usd.ts";
import { messageText } from "./history.ts";
import { publishMe } from "./stream.ts";

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

export interface StartChatOptions {
  readonly modelSelection?: ModelSelectionWire | null;
  readonly actMode?: ThreadActMode;
  readonly budgetUsd?: string;
}

/**
 * A new thread with Auni, titled by its first message, optionally carrying the
 * model selection and autonomy budget picked in the composer. The owner's first one ends first
 * run, in the same transaction: from then they're welcomed, and their starting points are on
 * their way. Until a chat is there, they're still in first run (a reload brings it back).
 */
export async function startChat(
  firstMessage: string,
  options: StartChatOptions = {},
): Promise<ThreadRow> {
  const { created, welcomed } = await db.transaction(async (tx) => {
    const me = await lockOwner(tx);
    const selection =
      options.modelSelection !== undefined ? options.modelSelection : me.defaultModelSelection;
    const actMode: ThreadActMode = options.actMode ?? "ask_first";
    const budgetUsd =
      options.budgetUsd !== undefined ? normalizeUsd(options.budgetUsd) : "0.00";
    const [row] = await tx
      .insert(threads)
      .values({
        title: chatTitle(firstMessage),
        actMode,
        budgetUsd,
        modelSelection: selection,
      })
      .returning();
    if (!row) throw new Error("Failed to start the chat.");
    // Remember an explicit choice as the default for the next new thread.
    if (options.modelSelection !== undefined)
      await tx.update(owner).set({ defaultModelSelection: options.modelSelection });
    if (me.welcomedAt !== null) return { created: row, welcomed: false };
    await tx.update(owner).set({ welcomedAt: sql`now()` });
    await refreshStartingPoints(tx, me.startingPointsAt);
    return { created: row, welcomed: true };
  });
  if (welcomed) publishMe();
  return created;
}

/**
 * Where to tell the owner of something that follows from a move of theirs: the thread the move was
 * made in, when it is still active (not archived), so the news sits beside what led to it; else
 * their main conversation (see mainChat).
 */
export async function chatOfMove(
  threadId: string | null,
  tx: Tx | typeof db,
): Promise<{ readonly id: string }> {
  if (threadId) {
    const [chat] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), isNull(threads.archivedAt)));
    if (chat) return chat;
  }
  return mainChat(tx);
}

/**
 * Auni's main conversation, where Auni speaks up unasked (news, the brief) and where a message
 * from a channel replying to nothing lands: the thread they were in last, not archived, and begun;
 * or with none yet, a new one.
 */
export async function mainChat(tx: Tx | typeof db): Promise<{ readonly id: string }> {
  const [chat] = await tx
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
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
    .returning({ id: threads.id });
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
