import type {
  automationCardSchema,
  automationFireWireSchema,
  AutomationStatus,
  automationWireSchema,
} from "@auni/shared";
import { EventEmitter } from "node:events";

import { and, count, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { db, type Tx } from "../db/client.ts";
import { automationFires, automations, type AutomationRow } from "../db/schema.ts";
import { triageKind } from "../jobs/kinds.ts";
import type { Executor } from "../jobs/queue.ts";
import { OutOfCredits, type SourceFire } from "../apps/contract.ts";
import { sourceById } from "../apps/registry.ts";
import { clearTrouble, noteTrouble } from "../app-troubles.ts";

// The hub's side of watching: a watch's row, its fires and what became of them. Sources (apps)
// only say what a condition is and when one came true; triage (triage.ts) judges each fire.

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** A length of time as the agent writes it: "0", "15m", "4h", "7d". */
export const durationSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,3}[mhd])$/u, 'a duration such as "15m", "4h" or "7d"');

export function durationMs(duration: string): number {
  if (duration === "0") return 0;
  const unit = duration.at(-1) as keyof typeof UNITS;
  return Number.parseInt(duration, 10) * UNITS[unit];
}

/** A watch's status as it stands now: one past its end has ended, before expireWatches says so. */
export function currentStatus(row: AutomationRow, now = new Date()): AutomationStatus {
  const ended = row.status === "active" && row.expiresAt !== null && row.expiresAt <= now;
  return ended ? "expired" : row.status;
}

/** What web and the agent see of a watch. */
export function automationWire(row: AutomationRow): z.input<typeof automationWireSchema> {
  return {
    id: row.id,
    threadId: row.threadId,
    source: row.source,
    description: row.description,
    note: row.note,
    condition: row.condition,
    repeat: row.repeat,
    status: currentStatus(row),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The in-chat card the watch tool hands the UI. */
export function automationCard(row: AutomationRow): z.input<typeof automationCardSchema> {
  return {
    kind: "automation",
    id: row.id,
    title: row.description.slice(0, 160),
    updatedAt: new Date().toISOString(),
    automationId: row.id,
    summary: row.description.slice(0, 500),
    status: currentStatus(row),
  };
}

/** Far more watches than anyone keeps (running or paused); it stops a script setting up hundreds. */
export const LIVE_AUTOMATIONS = 20;

/**
 * How many times a day the owner's repeating watches may fire past the hub. Each is judged on the
 * owner's own AI plan, and may wake a turn; past this a repeating watch's fire is recorded but
 * stays quiet. A one-shot watch always speaks: it fires once.
 */
export const DAILY_AUTOMATION_WAKES = 24;

/** What a watch is, as the agent sets it up or edits it. */
export interface WatchFields {
  readonly condition: Record<string, unknown>;
  readonly description: string;
  readonly note: string;
  /** Null fires once; otherwise the least time between fires that wake the thread. */
  readonly repeat: string | null;
  /** Null watches until deleted. */
  readonly expiresAt: Date | null;
}

function remoteOf(row: AutomationRow) {
  return sourceById(row.source)?.source.remote;
}

/**
 * Says, by the source's id, that one of its watches started or changed what it watches, so a
 * running source (runSource) reads its watches again at once and sees it from the moment it was
 * set up, not from its next look.
 */
export const watchesChanged = new EventEmitter();

function changed<Row extends AutomationRow | undefined>(row: Row): Row {
  if (row) watchesChanged.emit(row.source);
  return row;
}

export async function createAutomation(
  input: WatchFields & {
    readonly threadId: string;
    readonly source: string;
  },
): Promise<AutomationRow> {
  if (!sourceById(input.source)) throw new Error(`No source named ${input.source}.`);

  // Counted and stored under one lock, so watches set up at once can't all fit under it.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('auni:automations'))`);
    const [live] = await tx
      .select({ count: count() })
      .from(automations)
      .where(inArray(automations.status, ["active", "paused"]));
    if ((live?.count ?? 0) >= LIVE_AUTOMATIONS)
      throw new Error(
        `They already keep ${LIVE_AUTOMATIONS} watches; one has to be deleted before another can start.`,
      );
    // The row exists before any remote watch does, so a fire that lands at once finds it.
    const [stored] = await tx.insert(automations).values(input).returning();
    return stored;
  });
  if (!row) throw new Error("Failed to store the watch.");
  try {
    return (await startWatch(row, { waitForCredits: false })) ?? row;
  } catch (error) {
    await db.delete(automations).where(asRead(row));
    throw error;
  }
}

/**
 * Makes a stored watch active, with a fresh lease at its source when the source keeps watches
 * itself. Undefined when the row changed while the source answered (paused, deleted, or resumed
 * by another tap first): the new remote watch is removed again, so it never fires next to the
 * one that won. The watch it replaces is the caller's to remove.
 *
 * Credits running out under a watch already set is a wait, never a no: the row is made active on
 * the remote watch it already had, if any, and renewWatches gives it a fresh one once there are
 * credits again. A new watch (`waitForCredits` false) is refused instead, so nobody is told it
 * watches while it can't. Either way the app's sheet and doctor say its credits ran out.
 */
async function startWatch(
  row: AutomationRow,
  { waitForCredits = true }: { readonly waitForCredits?: boolean } = {},
): Promise<AutomationRow | undefined> {
  const stillAsRead = and(asRead(row), eq(automations.status, row.status));
  const installed = sourceById(row.source);
  const remote = installed?.source.remote;
  if (!installed || !remote) {
    const [stored] = await db
      .update(automations)
      .set({ status: "active" })
      .where(stillAsRead)
      .returning();
    return changed(stored);
  }
  let lease: { readonly ref: string; readonly until: Date };
  try {
    lease = await remote.watch({
      id: row.id,
      description: row.description,
      note: row.note,
      condition: row.condition,
      cooldownMs: row.repeat === null ? null : durationMs(row.repeat),
      expiresAt: row.expiresAt,
    });
  } catch (error) {
    if (!(error instanceof OutOfCredits)) throw error;
    await noteTrouble(installed.about, "watching", error);
    if (!waitForCredits) throw error;
    const [waiting] = await db
      .update(automations)
      .set({ status: "active" })
      .where(stillAsRead)
      .returning();
    return changed(waiting);
  }
  await clearTrouble(installed.about, "watching");
  const [stored] = await db
    .update(automations)
    .set({ status: "active", sourceRef: lease.ref, leaseUntil: lease.until })
    .where(stillAsRead)
    .returning();
  if (!stored) await remote.unwatch(lease.ref);
  return changed(stored);
}

/**
 * A fresh remote watch in place of the one the row holds, which is then removed: a watch left
 * behind would keep firing into the thread next to its replacement. Undefined as startWatch.
 */
export async function rewatch(row: AutomationRow): Promise<AutomationRow | undefined> {
  const fresh = await startWatch(row);
  if (fresh && row.sourceRef && fresh.sourceRef !== row.sourceRef) {
    await remoteOf(row)
      ?.unwatch(row.sourceRef)
      .catch((error: unknown) =>
        console.error(`old ${row.source} watch ${row.sourceRef} not removed`, error),
      );
  }
  return fresh;
}

/** The row still holds the remote watch it was read with, or still none. */
export function asRead(row: AutomationRow) {
  return and(
    eq(automations.id, row.id),
    row.sourceRef ? eq(automations.sourceRef, row.sourceRef) : isNull(automations.sourceRef),
  );
}

export async function automationById(id: string): Promise<AutomationRow | undefined> {
  const [row] = await db.select().from(automations).where(eq(automations.id, id));
  return row;
}

/** A watch that has ended: it fired once, ran out its time, or its source stopped taking it. */
const ENDED: readonly AutomationStatus[] = ["triggered", "expired", "failed"];

/**
 * Changes what a watch looks out for or says. A source that keeps watches itself gets a fresh
 * one when what it watches changed; a running source reads the change at once. A watch that has
 * ended stays ended, so it can't be changed: a new one is set up instead, under the cap on watches.
 */
export async function editAutomation(
  row: AutomationRow,
  changes: Partial<WatchFields>,
): Promise<AutomationRow> {
  if (ENDED.includes(row.status))
    throw new Error(`That watch has ended (${row.status}); set up a new one instead.`);
  const [edited] = await db
    .update(automations)
    .set(changes)
    .where(and(asRead(row), eq(automations.status, row.status)))
    .returning();
  // A renewal, resume or fire changed it meanwhile; the edit goes onto it as it is now.
  if (!edited) {
    const fresh = await automationById(row.id);
    if (!fresh || fresh.status === "deleted") throw new Error("No such watch.");
    return editAutomation(fresh, changes);
  }
  const watched = "condition" in changes || "repeat" in changes || "expiresAt" in changes;
  if (!watched || edited.status !== "active" || !remoteOf(edited)) return changed(edited);
  return (await rewatch(edited)) ?? (await automationById(row.id)) ?? edited;
}

export async function deleteAutomation(row: AutomationRow): Promise<AutomationRow> {
  if (row.sourceRef) await remoteOf(row)?.unwatch(row.sourceRef);
  const [deleted] = await db
    .update(automations)
    .set({ status: "deleted" })
    .where(asRead(row))
    .returning();
  if (deleted) return deleted;
  // A renewal or resume put in a new remote watch meanwhile; that one goes too.
  const fresh = await automationById(row.id);
  return fresh ? deleteAutomation(fresh) : row;
}

/** Stops the source watching, keeping the watch to resume. */
export async function pauseAutomation(row: AutomationRow): Promise<AutomationRow> {
  if (row.sourceRef) await remoteOf(row)?.unwatch(row.sourceRef);
  const [paused] = await db
    .update(automations)
    .set({ status: "paused", sourceRef: null, leaseUntil: null })
    .where(asRead(row))
    .returning();
  if (paused) return paused;
  // A renewal put in a new remote watch meanwhile; that one goes too, unless a delete got there first.
  const fresh = await automationById(row.id);
  return fresh && fresh.status !== "deleted" ? pauseAutomation(fresh) : (fresh ?? row);
}

/** Watches again, as if just set up. */
export async function resumeAutomation(row: AutomationRow): Promise<AutomationRow> {
  // A resume that lost to another tap gets the row as the winner left it.
  return (await startWatch(row)) ?? (await automationById(row.id)) ?? row;
}

/** The watches, newest first. Deleted ones stay hidden. */
export async function listAutomations(input: {
  readonly threadId?: string;
}): Promise<AutomationRow[]> {
  return db
    .select()
    .from(automations)
    .where(
      and(
        ne(automations.status, "deleted"),
        input.threadId ? eq(automations.threadId, input.threadId) : undefined,
      ),
    )
    .orderBy(desc(automations.createdAt));
}

/** A fire past the hub, whatever triage made of it or is about to: one the hub didn't quiet. */
const spokeUp = sql`${automationFires.verdict} is distinct from 'quiet'`;

/** A thread's or every watch's fires past the hub, newest first. */
export async function listFires(input: {
  readonly threadId?: string;
}): Promise<z.input<typeof automationFireWireSchema>[]> {
  const rows = await db
    .select({
      id: automationFires.id,
      automationId: automations.id,
      description: automations.description,
      firedAt: automationFires.createdAt,
      late: automationFires.late,
      verdict: automationFires.verdict,
      reason: automationFires.reason,
      messageId: automationFires.messageId,
      outcome: automationFires.outcome,
    })
    .from(automationFires)
    .innerJoin(automations, eq(automations.id, automationFires.automationId))
    .where(and(spokeUp, input.threadId ? eq(automations.threadId, input.threadId) : undefined))
    .orderBy(desc(automationFires.createdAt))
    .limit(100);
  return rows.map((row) => ({ ...row, firedAt: row.firedAt.toISOString() }));
}

/** How long a thread's fires wait for more before triage judges them together. */
const FOLD_MS = 15_000;

/**
 * Queues triage for a thread's waiting fires, FOLD_MS from now, so fires landing close together
 * are judged in one run. It reopens the thread's last finished run, which kept its key.
 */
export async function judgeSoon(tx: Executor, threadId: string): Promise<void> {
  await triageKind.enqueue(tx, { threadId }, { key: `triage:${threadId}`, debounceMs: FOLD_MS });
}

/** What recordFire made of a fire. */
export type FireRecorded =
  /** Recorded before (a redelivery or replay), or for a watch that isn't watching now. */
  | "ignored"
  /** Kept without waking anyone: a story already told, a cooldown, the day's cap. */
  | "quiet"
  /** Kept for triage, queued in the same transaction, to judge whether it wakes the thread. */
  | "triage";

/**
 * Records one fire and, unless the hub holds it back, queues its thread's triage in the same
 * transaction, so the two commit together or not at all: if queueing fails, nothing is recorded,
 * and the source's redelivery or replay tries again. A fire told twice is recorded once. A
 * repeating watch speaks up once per story, at most once per its cooldown, and within the day's
 * cap; a one-shot watch speaks, and ends. Fires for one thread close together are judged in one
 * triage run (FOLD_MS), which may wake one turn for them all.
 */
export async function recordFire(input: {
  readonly automation: AutomationRow;
  readonly fire: SourceFire;
}): Promise<FireRecorded> {
  const { fire } = input;
  const repeating = input.automation.repeat !== null;
  return db.transaction(async (tx) => {
    // Repeating watches count their day's fires one at a time, so fires landing together can't
    // all read the count below the cap. Taken before the watch's lock, always.
    if (repeating)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('auni:automation-wakes'))`);
    // Fires on one watch go one at a time, so two reports of one story can't both speak, and
    // two fires of a one-shot can't both speak.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.automation.id}))`);
    // Read again under the lock: an earlier fire may have ended it or started its cooldown.
    const [automation] = await tx
      .select()
      .from(automations)
      .where(eq(automations.id, input.automation.id));
    if (!automation || currentStatus(automation) !== "active") return "ignored";

    const [told] = fire.story
      ? await tx
          .select({ id: automationFires.id })
          .from(automationFires)
          .where(
            and(
              eq(automationFires.automationId, automation.id),
              eq(automationFires.storylineId, fire.story),
              // One quieted by a cooldown or the cap is still untold.
              spokeUp,
            ),
          )
          .limit(1)
      : [];
    const coolingDown =
      automation.repeat !== null &&
      automation.lastFiredAt !== null &&
      Date.now() - automation.lastFiredAt.getTime() < durationMs(automation.repeat);
    const [spokeToday] = !repeating
      ? []
      : await tx
          .select({ count: count() })
          .from(automationFires)
          .where(and(spokeUp, gt(automationFires.createdAt, sql`now() - interval '1 day'`)));
    // A time the owner asked to be woken at is kept, however many fires spoke today.
    const capped =
      (spokeToday?.count ?? 0) >= DAILY_AUTOMATION_WAKES &&
      !sourceById(automation.source)?.source.alwaysWakes;
    if (capped) console.warn("watch fires capped for the day");
    const quiet = Boolean(told) || coolingDown || capped;

    const [recorded] = await tx
      .insert(automationFires)
      .values({
        automationId: automation.id,
        eventId: fire.id,
        payload: fire.report,
        storylineId: fire.story ?? null,
        happenedAt: fire.at,
        late: fire.late ?? false,
        verdict: quiet ? "quiet" : null,
      })
      .onConflictDoNothing({ target: [automationFires.automationId, automationFires.eventId] })
      .returning({ id: automationFires.id });
    if (!recorded) return "ignored";
    if (quiet) return "quiet";
    await tx
      .update(automations)
      .set({ lastFiredAt: sql`now()`, ...(repeating ? {} : { status: "triggered" }) })
      .where(eq(automations.id, automation.id));
    await judgeSoon(tx, automation.threadId);
    return "triage";
  });
}

/**
 * Ties fires to the answer they woke, keeping what it made of them as their outcome. In the
 * transaction that keeps that answer, so a fire is told only with an answer.
 */
export async function settleFires(
  tx: Tx,
  fireIds: readonly string[],
  messageId: string,
  outcome: string | null,
): Promise<void> {
  if (fireIds.length === 0) return;
  await tx
    .update(automationFires)
    .set({ messageId, outcome })
    .where(inArray(automationFires.id, [...fireIds]));
}

/** The first sentence, without markdown, short enough for one line. */
export function openingLine(text: string): string | null {
  const line = text
    .split("\n")
    .find((entry) => entry.trim())
    ?.replace(/[*_`#>]/gu, "")
    .trim();
  if (!line) return null;
  const sentence = /^.+?[.!?](?=\s|$)/u.exec(line)?.[0] ?? line;
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}
