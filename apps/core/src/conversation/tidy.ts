import type { ModelSelectionWire, ThreadActMode } from "@auni/shared";
import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import {
  actions,
  automationFires,
  automations,
  channelDeliveries,
  jobs,
  messages,
  owner,
  threads,
  type ThreadRow,
} from "../db/schema.ts";
import { normalizeUsd } from "../money/usd.ts";

// How the owner tidies and configures their threads: renaming, pinning, archiving, deleting,
// switching model/effort, and setting autonomy budget. Tidying never touches money: a move's
// record stays whatever happens to the thread it was made in, so Activity and Portfolio read the
// same before and after.

/** Why a chat can't be tidied as asked: a code for code, and a sentence for the owner. */
export interface TidyRefusal {
  readonly error: "card_waiting" | "still_telling" | "move_landing" | "watching";
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

/** Renames a thread. */
export async function renameChat(thread: ThreadRow, title: string): Promise<void> {
  await db.update(threads).set({ title }).where(eq(threads.id, thread.id));
}

/** Pins or unpins a thread to the top of the sidebar. */
export async function pinChat(thread: ThreadRow, pinned: boolean): Promise<void> {
  await db
    .update(threads)
    .set({ pinnedAt: pinned ? sql`now()` : null })
    .where(eq(threads.id, thread.id));
}

/** Updates a thread's autonomy mode and/or spending ceiling (owner route only). */
export async function updateThreadAutonomy(
  thread: ThreadRow,
  patch: { readonly actMode?: ThreadActMode; readonly budgetUsd?: string },
): Promise<void> {
  await db
    .update(threads)
    .set({
      ...(patch.actMode !== undefined ? { actMode: patch.actMode } : {}),
      ...(patch.budgetUsd !== undefined ? { budgetUsd: normalizeUsd(patch.budgetUsd) } : {}),
    })
    .where(eq(threads.id, thread.id));
}

/** Updates a thread's model selection and remembers it as the owner's default for new threads. */
export async function updateThreadModel(
  thread: ThreadRow,
  modelSelection: ModelSelectionWire | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(threads).set({ modelSelection }).where(eq(threads.id, thread.id));
    await tx.update(owner).set({ defaultModelSelection: modelSelection });
  });
}

/**
 * Archives a thread out of the sidebar, or brings it back. A thread with a card waiting stays,
 * since archiving it would put the card away unseen.
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
    if (await cardWaiting(tx, thread.id)) return CARD_WAITING;
    await tx
      .update(threads)
      .set({ archivedAt: sql`now()`, pinnedAt: null })
      .where(eq(threads.id, thread.id));
  });
}

/**
 * Deletes a thread for good: its messages, and what only made sense inside it (the channel
 * messages that pointed at it, its ended watches). Every move made in it keeps its record,
 * now outside any thread, as a withdrawal from Settings is.
 *
 * Refused while anything there still needs the thread: something Auni has still to tell there,
 * a card waiting, a move still landing, or an active/paused watch that would wake it.
 */
export async function deleteChat(thread: ThreadRow): Promise<TidyRefusal | undefined> {
  return db.transaction(async (tx) => {
    // A card or a watch recorded in this thread meanwhile waits for this lock, then finds it gone.
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
        "A move made here is still landing, and Auni tells you how it went in this thread. Delete it once it has landed.",
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
        `This thread has ${watches}. When ${live.length === 1 ? "it comes" : "one comes"} true, Auni wakes this thread to tell you. Ask Auni here to stop watching, or archive the thread instead.`,
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

/** Removes a thread and what only it used, keeping every money record. */
async function forget(tx: Tx, threadId: string): Promise<void> {
  await tx.update(actions).set({ threadId: null }).where(eq(actions.threadId, threadId));
  await tx.delete(channelDeliveries).where(eq(channelDeliveries.threadId, threadId));
  const ended = tx
    .select({ id: automations.id })
    .from(automations)
    .where(eq(automations.threadId, threadId));
  await tx.delete(automationFires).where(inArray(automationFires.automationId, ended));
  await tx.delete(automations).where(eq(automations.threadId, threadId));
  await tx.delete(messages).where(eq(messages.threadId, threadId));
  await tx.delete(threads).where(eq(threads.id, threadId));
}
