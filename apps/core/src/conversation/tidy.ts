import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import {
  actions,
  automationFires,
  automations,
  channelDeliveries,
  jobs,
  messages,
  specialists,
  specialistUpdates,
  threads,
  type ThreadRow,
} from "../db/schema.ts";

// How the owner tidies their chats: renaming one, archiving it out of History, and deleting it for
// good. Tidying never touches money: a move's record stays whatever happens to the chat it was
// made in, so Activity and the portfolio read the same before and after. What tidying must not
// do is hide something that still needs the owner, or leave a watch with no chat to wake, so each
// of those is refused in words. An archived chat comes back by itself with Auni's next answer
// there (`answered`), so nothing Auni says later lands where nobody looks.

/** Why a chat can't be tidied as asked: a code for code, and a sentence for the owner. */
export interface TidyRefusal {
  readonly error:
    | "specialist_at_work"
    | "specialist_record"
    | "card_waiting"
    | "still_telling"
    | "move_landing"
    | "watching";
  readonly message: string;
}

const refused = (error: TidyRefusal["error"], message: string): TidyRefusal => ({
  error,
  message,
});

/**
 * The fields a thread takes when Auni leaves an answer in it the owner hasn't read: it is unread,
 * and if it was archived it comes back, so a watch, a move landing or the brief never speaks
 * into a chat nobody looks at. A quiet answer isn't one.
 */
export function answered() {
  return { repliedAt: sql`now()`, archivedAt: null };
}

/** A card in the thread waits on the owner: one to allow, or a held move to check. */
async function cardWaiting(tx: Tx | typeof db, threadId: string): Promise<boolean> {
  const [waiting] = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.threadId, threadId),
        or(eq(actions.status, "awaiting_permission"), eq(actions.phase, "needs_owner")),
      ),
    )
    .limit(1);
  return waiting !== undefined;
}

const CARD_WAITING = refused(
  "card_waiting",
  "A card here still waits for your answer. Answer it first, even with Not now, so it isn't put away unseen.",
);

/** Renames a chat. A specialist's name is its own, changed on its page, never by its thread. */
export async function renameChat(
  thread: ThreadRow,
  title: string,
): Promise<TidyRefusal | undefined> {
  if (thread.specialistId)
    return refused(
      "specialist_record",
      "A specialist's chat goes by the specialist's name. Rename it from its page.",
    );
  await db.update(threads).set({ title }).where(eq(threads.id, thread.id));
}

/**
 * Archives a chat out of History, or brings it back. A specialist's chat is the specialist, so
 * it is archived only once the specialist is retired: archiving is not retiring it. A chat with
 * a card waiting stays, since archiving it would put the card away unseen.
 */
export async function archiveChat(
  thread: ThreadRow,
  archived: boolean,
): Promise<TidyRefusal | undefined> {
  if (!archived) {
    await db.update(threads).set({ archivedAt: null }).where(eq(threads.id, thread.id));
    return;
  }
  return db.transaction(async (tx) => {
    // Held while it checks, so a card recorded meanwhile is seen or waits for the archive.
    await tx
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, thread.id))
      .for("update");
    if (thread.specialistId) {
      const [specialist] = await tx
        .select({ status: specialists.status })
        .from(specialists)
        .where(eq(specialists.id, thread.specialistId));
      if (specialist?.status !== "retired")
        return refused(
          "specialist_at_work",
          "This specialist is still at work. Retire it first; its chat moves to History, and can be archived from there.",
        );
    }
    if (await cardWaiting(tx, thread.id)) return CARD_WAITING;
    await tx
      .update(threads)
      .set({ archivedAt: sql`now()` })
      .where(eq(threads.id, thread.id));
  });
}

/**
 * Deletes a chat for good: its messages, and what only made sense inside it (the channel
 * messages that pointed at it, its undo receipts, its ended watches). Every move made in it
 * keeps its record, now outside any chat, as a withdrawal from Settings is.
 *
 * Refused while anything there still needs the chat: a specialist's (its chat is its record),
 * something Auni has still to tell there (a turn queued or running, a watch's fire not yet
 * judged or held for the brief), a card waiting, a move still landing (its news comes back to
 * the chat), or a watch that would wake it, which is named so the owner can ask Auni to stop it.
 */
export async function deleteChat(thread: ThreadRow): Promise<TidyRefusal | undefined> {
  if (thread.specialistId)
    return refused(
      "specialist_record",
      "A specialist's chat is its record, so it can be archived once the specialist is retired, but not deleted.",
    );
  return db.transaction(async (tx) => {
    // A card or a watch recorded in this chat meanwhile waits for this lock, then finds it gone.
    const [locked] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, thread.id))
      .for("update");
    if (!locked) return;
    if (await stillTelling(tx, thread.id))
      return refused(
        "still_telling",
        "Auni still has something to tell you here, now or in your next brief. Delete it once that's told.",
      );
    if (await cardWaiting(tx, thread.id)) return CARD_WAITING;
    const [landing] = await tx
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.threadId, thread.id), eq(actions.status, "running")))
      .limit(1);
    if (landing)
      return refused(
        "move_landing",
        "A move made here is still landing, and Auni tells you how it went in this chat. Delete it once it has landed.",
      );
    const live = await tx
      .select({ description: automations.description })
      .from(automations)
      .where(
        and(eq(automations.threadId, thread.id), inArray(automations.status, ["active", "paused"])),
      );
    if (live.length > 0) {
      const named = live.map(({ description }) => `“${description}”`).join(" and ");
      const watches = live.length === 1 ? `a watch, ${named}` : `${live.length} watches, ${named}`;
      return refused(
        "watching",
        `This chat has ${watches}. When ${live.length === 1 ? "it comes" : "one comes"} true, Auni wakes this chat to tell you. Ask Auni here to stop watching, or archive the chat instead.`,
      );
    }
    await forget(tx, thread.id);
  });
}

/**
 * Whether Auni has something still to say in the thread: a turn queued or running (an answer,
 * a wake), a watch's fires waiting to be judged, or a fire held for the brief, all of which
 * speak there or name it.
 */
async function stillTelling(tx: Tx, threadId: string): Promise<boolean> {
  const [job] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        isNull(jobs.finishedAt),
        sql`${jobs.lanes} && array[${`thread:${threadId}`}, ${`triage:${threadId}`}]::text[]`,
      ),
    )
    .limit(1);
  if (job) return true;
  const [fire] = await tx
    .select({ id: automationFires.id })
    .from(automationFires)
    .where(
      and(
        exists(
          tx
            .select({ one: sql`1` })
            .from(automations)
            .where(
              and(
                eq(automations.id, automationFires.automationId),
                eq(automations.threadId, threadId),
              ),
            ),
        ),
        or(
          isNull(automationFires.verdict),
          and(eq(automationFires.verdict, "brief"), isNull(automationFires.briefedAt)),
        ),
      ),
    )
    .limit(1);
  return fire !== undefined;
}

/** Removes a chat and what only it used, keeping every money record. */
async function forget(tx: Tx, threadId: string): Promise<void> {
  await tx.update(actions).set({ threadId: null }).where(eq(actions.threadId, threadId));
  await tx.delete(channelDeliveries).where(eq(channelDeliveries.threadId, threadId));
  await tx.delete(specialistUpdates).where(eq(specialistUpdates.threadId, threadId));
  const ended = tx
    .select({ id: automations.id })
    .from(automations)
    .where(eq(automations.threadId, threadId));
  await tx.delete(automationFires).where(inArray(automationFires.automationId, ended));
  await tx.delete(automations).where(eq(automations.threadId, threadId));
  await tx.delete(messages).where(eq(messages.threadId, threadId));
  await tx.delete(threads).where(eq(threads.id, threadId));
}
