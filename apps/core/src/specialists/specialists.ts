import type { ActionStatus, specialistWireSchema } from "@auni/shared";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { z } from "zod";

import { deleteSpecialistAutomations } from "../automations/automations.ts";
import { theOwner } from "../auth/owner.ts";
import { db, type Tx } from "../db/client.ts";
import type { Executor } from "../jobs/queue.ts";
import {
  actions,
  specialists,
  threads,
  type ActionRow,
  type SpecialistFields,
  type SpecialistRow,
} from "../db/schema.ts";
import { holdingViews } from "../money/holdings.ts";
import { retract } from "../money/life.ts";
import { specialistFlows, madeUsd, unpricedOf } from "../money/made.ts";
import { portfolioNow, readPortfolio, type Portfolio } from "../money/portfolio.ts";
import { inRecordOf, stillSettling } from "../money/readings.ts";
import { activityLabel, differenceUsd } from "../money/summaries.ts";
import { madeAtStartOfDay, startOfDay } from "../money/value-history.ts";

type SpecialistView = z.input<typeof specialistWireSchema>;

export async function specialistById(specialistId: string): Promise<SpecialistRow | undefined> {
  const [row] = await db.select().from(specialists).where(eq(specialists.id, specialistId));
  return row;
}

async function views(
  rows: readonly SpecialistRow[],
  portfolio: Portfolio,
): Promise<SpecialistView[]> {
  const ids = rows.map((row) => row.id);
  const [flows, starts] = await Promise.all([specialistFlows(ids), startedIn(ids)]);
  const today = startOfDay((await theOwner()).timeZone);
  const madeAtMidnight = await madeAtStartOfDay(flows);
  return Promise.all(
    rows.map(async (row) => {
      const bucket = portfolio.specialists.find((entry) => entry.id === row.id);
      const valueUsd = bucket?.usdValue ?? "0.00";
      // Money a trade put in or took out today is no move of the day.
      const theirs = flows.get(row.id) ?? [];
      const made = madeUsd(
        Number(valueUsd),
        0,
        theirs,
        Infinity,
        unpricedOf(bucket?.holdings ?? []),
      );
      const baseline = madeAtMidnight.get(row.id);
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        purpose: row.purpose,
        theme: row.theme,
        rules: { actMode: row.actMode },
        potUsd: row.potUsd,
        pulse: row.pulse,
        notes: row.notes,
        report: row.report,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        retiredAt: row.retiredAt?.toISOString() ?? null,
        valueUsd,
        madeUsd: made,
        todayChangeUsd: baseline ? differenceUsd(made, baseline) : "0.00",
        holdings: await holdingViews(bucket?.holdings ?? [], today),
        startedIn: starts.get(row.id) ?? null,
      };
    }),
  );
}

/**
 * The chat each specialist was started from: where the first card for it was, a chat of the
 * owner's rather than its own conversation.
 */
async function startedIn(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([actions.specialistId], {
      specialistId: actions.specialistId,
      threadId: threads.id,
    })
    .from(actions)
    .innerJoin(threads, eq(threads.id, actions.threadId))
    .where(and(inArray(actions.specialistId, [...ids]), isNull(threads.specialistId)))
    .orderBy(actions.specialistId, asc(actions.createdAt));
  return new Map(rows.map(({ specialistId, threadId }) => [specialistId!, threadId]));
}

/**
 * Every specialist, newest first, valued live, retired ones included: the web
 * decides which it lists where.
 */
export async function listSpecialistViews(): Promise<SpecialistView[]> {
  const [rows, portfolio] = await Promise.all([
    db.select().from(specialists).orderBy(desc(specialists.createdAt)),
    portfolioNow(),
  ]);
  return views(rows, portfolio);
}

/**
 * One specialist, retired ones included (their history stays), valued by
 * `read`: a screen's portfolioNow, or readPortfolio for the agent, who decides
 * by it.
 */
export async function specialistDetail(
  specialistId: string,
  read: () => Promise<Portfolio>,
): Promise<SpecialistView | null> {
  const row = await specialistById(specialistId);
  if (!row) return null;
  const [view] = await views([row], await read());
  return view ?? null;
}

/**
 * Everything Auni did or asked for a specialist, newest first, one line each,
 * as the agent reads it: what a person sees is their activity (see activity.ts).
 */
export async function specialistActivity(
  specialistId: string,
  limit: number,
): Promise<{ id: string; label: string; status: ActionStatus; occurredAt: string }[]> {
  const rows = await db
    .select()
    .from(actions)
    // A replaced draft never happened; the plan that replaced it is the record.
    .where(and(inRecordOf([specialistId]), ne(actions.status, "replaced")))
    .orderBy(desc(actions.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    label: activityLabel(row),
    status: row.status,
    occurredAt: row.updatedAt.toISOString(),
  }));
}

/** The glyphs the web's orb draws; Auni picks one when it proposes a specialist. */
export const SPECIALIST_THEMES = [
  "pill",
  "tennis",
  "chip",
  "bolt",
  "leaf",
  "globe",
  "coin",
  "chart",
] as const;
export type SpecialistTheme = (typeof SPECIALIST_THEMES)[number];

/** What a new specialist is made with; everything else (its pulse, notes, report) starts empty. */
export type SpecialistStart = Pick<
  typeof specialists.$inferInsert,
  "kind" | "name" | "purpose" | "theme" | "potUsd" | "actMode"
>;

/**
 * A new specialist, made in the transaction of the card that brings it, so neither is ever left
 * without the other: start_specialist's ask, as it's allowed (asks.ts), or a take's first picks,
 * as they're proposed (recordActions).
 */
export async function createSpecialist(tx: Tx, start: SpecialistStart): Promise<string> {
  const [row] = await tx.insert(specialists).values(start).returning({ id: specialists.id });
  if (!row) throw new Error("Failed to start the specialist.");
  return row.id;
}

/**
 * Retires each take among `declined`'s specialists that never had a move: one its first card
 * began (propose_specialist_portfolio's take), every card of it declined, replaced or taken back.
 * It holds nothing and never did, so the owner's No to that card is a No to the take too.
 * Returns the takes retired; the caller runs specialistRetired for each once its transaction is in.
 */
export async function retireUnstartedTakes(
  tx: Tx,
  declined: readonly Pick<ActionRow, "specialistId">[],
): Promise<Pick<SpecialistRow, "id" | "name">[]> {
  const ids = [...new Set(declined.flatMap(({ specialistId }) => specialistId ?? []))];
  if (ids.length === 0) return [];
  return tx
    .update(specialists)
    .set({ status: "retired", retiredAt: sql`now()` })
    .where(
      and(
        inArray(specialists.id, ids),
        eq(specialists.kind, "take"),
        eq(specialists.status, "active"),
        sql`not exists (
          select 1 from ${actions}
          where ${actions.specialistId} = ${specialists.id}
            and ${actions.status} not in ('cancelled', 'replaced', 'retracted')
        )`,
      ),
    )
    .returning({ id: specialists.id, name: specialists.name });
}

/**
 * Forgets the pulse of the specialist whose own conversation `threadId` is, as a card there
 * settles. A pulse is the agent's read as of its last turn, often of the card itself ("$3 into
 * NVIDIA proposed, waiting on your tap"), and once the card has gone through, failed or been
 * declined, that read is out of date: the live test of 2026-11-13 showed a failed plan's
 * "waiting on your tap" on the team list until the agent happened to rewrite it. The turn the
 * settlement wakes writes a new one; until then the line says what it holds (see the web's
 * teamLine). A conversation of no specialist changes nothing.
 */
export async function outdatePulse(executor: Executor, threadId: string): Promise<void> {
  await executor.execute(
    sql`update specialists set pulse = null
        where id = (select specialist_id from threads where id = ${threadId})`,
  );
}

export type SpecialistPatch = SpecialistFields & {
  pulse?: string;
  notes?: string;
  /** Retires it, keeping the report it wrote: null when the owner retires an empty one. */
  retire?: { readonly report: string | null };
};

/** Applies a patch to a specialist not yet retired, inside the caller's transaction. */
export async function applySpecialistPatch(
  tx: Tx,
  specialistId: string,
  patch: SpecialistPatch,
): Promise<SpecialistRow | undefined> {
  const { retire, ...fields } = patch;
  const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  const open = and(eq(specialists.id, specialistId), ne(specialists.status, "retired"));
  if (Object.keys(set).length === 0 && !retire) {
    const [current] = await tx.select().from(specialists).where(open);
    return current;
  }
  const [updated] = await tx
    .update(specialists)
    .set({
      ...set,
      ...(retire
        ? { status: "retired" as const, retiredAt: sql`now()`, report: retire.report }
        : {}),
    })
    .where(open)
    .returning();
  if (!updated) return undefined;
  // The place's conversation carries its name.
  if (patch.name !== undefined)
    await tx
      .update(threads)
      .set({ title: updated.name })
      .where(eq(threads.specialistId, updated.id));
  // No old tap can buy into it.
  if (updated.status === "retired")
    await retract(tx, eq(actions.specialistId, updated.id), "retired");
  return updated;
}

export async function updateSpecialist(
  specialistId: string,
  patch: SpecialistPatch,
): Promise<SpecialistRow | undefined> {
  const row = await db.transaction((tx) => applySpecialistPatch(tx, specialistId, patch));
  if (row?.status === "retired") await specialistRetired(row.id);
  return row;
}

/**
 * Its name and the words of its purpose, whatever its status: a retired
 * specialist keeps its row in the sidebar until archived, so it can still be renamed.
 */
export async function renameSpecialist(
  specialistId: string,
  names: Pick<SpecialistFields, "purpose" | "name">,
): Promise<SpecialistRow | undefined> {
  const set = Object.fromEntries(Object.entries(names).filter(([, value]) => value !== undefined));
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(specialists)
      .set(set)
      .where(eq(specialists.id, specialistId))
      .returning();
    // The place's conversation carries its name.
    if (updated && names.name !== undefined)
      await tx
        .update(threads)
        .set({ title: updated.name })
        .where(eq(threads.specialistId, updated.id));
    return updated;
  });
}

type RetireOutcome = "retired" | "already_retired" | "holds_money" | "in_flight" | "unreadable";

/** Thrown inside the retirement's transaction to undo it. */
class StillMoving extends Error {}

/**
 * The person retires one that holds nothing, from its row or its "…": with
 * nothing to sell there is nothing to ask Auni, and no report. Read fresh, since
 * a buy that landed seconds ago must not be stranded in a retired specialist; a
 * venue that can't be read, or a move running or just settled, keeps it active.
 */
export async function retireEmptySpecialist(specialistId: string): Promise<RetireOutcome> {
  const readStarted = Date.now();
  const portfolio = await readPortfolio();
  if (portfolio.unavailable.length > 0) return "unreadable";
  const bucket = portfolio.specialists.find((entry) => entry.id === specialistId);
  // An unpriced holding may still be worth something.
  if (bucket?.holdings.some(({ usdValue }) => usdValue === null || Number(usdValue) !== 0))
    return "holds_money";
  try {
    const outcome = await db.transaction(async (tx): Promise<RetireOutcome> => {
      const [current] = await tx
        .select()
        .from(specialists)
        .where(eq(specialists.id, specialistId))
        .for("update");
      if (!current || current.status === "retired") return "already_retired";
      // Taking back what waits comes first: an Allow that got in ahead of it is
      // running by the check below, and one that comes after finds it taken back.
      await applySpecialistPatch(tx, specialistId, { retire: { report: null } });
      const [moving] = await tx
        .select({ id: actions.id })
        .from(actions)
        .where(and(eq(actions.specialistId, specialistId), stillSettling(readStarted)))
        .limit(1);
      if (moving) throw new StillMoving();
      return "retired";
    });
    if (outcome === "retired") await specialistRetired(specialistId);
    return outcome;
  } catch (error) {
    if (error instanceof StillMoving) return "in_flight";
    throw error;
  }
}

/** Nothing should keep watching for a retired specialist; a failure here must not undo it. */
export async function specialistRetired(specialistId: string): Promise<void> {
  await deleteSpecialistAutomations(specialistId).catch((error: unknown) =>
    console.error(`automations for retired specialist ${specialistId} not deleted`, error),
  );
}
