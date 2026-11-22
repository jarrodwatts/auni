import { setTimeout as sleep } from "node:timers/promises";

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.ts";
import { automations } from "../db/schema.ts";
import { defineJob, jobKind } from "../jobs/queue.ts";
import { WatchRefused } from "../apps/contract.ts";
import { offered, sourceById, sources } from "../apps/registry.ts";
import { asRead, rewatch } from "./automations.ts";

/** A lease ending within this long is renewed now, so a run that fails still leaves time. */
const RENEW_AHEAD_MS = 24 * 60 * 60 * 1_000;

/** Between calls to a source's service: a pace well inside any service's rate limit. */
const PACE_MS = 2_000;

/**
 * Every six hours: watches past their end are ended, and each active watch a service keeps for
 * Auni is looked at and renewed when it needs it (renewWatch), one at a time.
 */
export const automationRenewJob = defineJob({
  kind: jobKind("automation-renew", z.object({})),
  every: 6 * 60 * 60_000,
  run: async () => {
    await expireWatches();
    for (const [index, id] of (await remoteWatchIds()).entries()) {
      if (index > 0) await sleep(PACE_MS);
      // One watch the service won't take never holds up the rest; the next run tries it again.
      await renewWatch(id).catch((error: unknown) =>
        console.error(`watch ${id} not renewed`, error),
      );
    }
  },
});

/** Ends the watches past their end, removing any watch a service still keeps for one. */
export async function expireWatches(): Promise<number> {
  const ended = await db
    .update(automations)
    .set({ status: "expired" })
    .where(and(eq(automations.status, "active"), lte(automations.expiresAt, sql`now()`)))
    .returning();
  for (const row of ended) {
    if (!row.sourceRef) continue;
    await sourceById(row.source)
      ?.source.remote?.unwatch(row.sourceRef)
      .catch((error: unknown) =>
        console.error(`ended ${row.source} watch ${row.sourceRef} not removed`, error),
      );
  }
  return ended.length;
}

/** Active watches whose source keeps them itself (RemoteWatching). */
export async function remoteWatchIds(): Promise<string[]> {
  const remote = sources(offered()).flatMap(({ about, source }) =>
    source.remote && source.configured() ? [about.id] : [],
  );
  if (remote.length === 0) return [];
  const rows = await db
    .select({ id: automations.id })
    .from(automations)
    .where(and(eq(automations.status, "active"), inArray(automations.source, remote)));
  return rows.map((row) => row.id);
}

/**
 * One watch a service keeps: a fresh one in its place when it has none yet (credits ran out when
 * it was set up), when its lease ends within a day and the watch goes on past it, or when the
 * service says it stopped watching (it failed it, or it ran its course there). A condition the
 * service now refuses fails the watch, so the owner sees it stopped.
 */
export async function renewWatch(id: string): Promise<string> {
  const [automation] = await db.select().from(automations).where(eq(automations.id, id));
  if (!automation || automation.status !== "active") return "skipped";
  const remote = sourceById(automation.source)?.source.remote;
  if (!remote) return "skipped";
  const { sourceRef, leaseUntil, expiresAt } = automation;
  const leaseEnding =
    leaseUntil !== null &&
    leaseUntil.getTime() < Date.now() + RENEW_AHEAD_MS &&
    (expiresAt === null || expiresAt > leaseUntil);
  const due = !sourceRef || leaseEnding || !(await remote.watching(sourceRef));
  if (!due) return "watching";

  const watched = await rewatch(automation).catch(async (error: unknown) => {
    if (!(error instanceof WatchRefused)) throw error;
    const [failed] = await db
      .update(automations)
      .set({ status: "failed" })
      .where(and(asRead(automation), eq(automations.status, "active")))
      .returning();
    if (failed && sourceRef) await remote.unwatch(sourceRef).catch(() => undefined);
    return "refused" as const;
  });
  if (watched === "refused") return "refused; failed";
  if (!watched) return "changed meanwhile; skipped";
  if (watched.sourceRef === sourceRef) return "out of credits; tries again next run";
  return "renewed";
}
