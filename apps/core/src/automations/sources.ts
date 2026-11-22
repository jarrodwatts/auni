import { and, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.ts";
import { automations, sourceCursors } from "../db/schema.ts";
import { keepRunning, untilSettingsChange } from "../jobs/keep-running.ts";
import { defineJob, jobKind } from "../jobs/queue.ts";
import type { SourceFire, SourceWatch } from "../apps/contract.ts";
import { offered, sourceById, sources } from "../apps/registry.ts";
import { recordFire, watchesChanged, type FireRecorded } from "./automations.ts";

// Where fires come in from a source's run (contract.ts, Source), and where that run's place is
// kept. sourcesJob keeps each configured source's run going inside the job runner.

/** How often a running source's list of watches is read again, so a new one is watched soon. */
const WATCHES_REFRESH_MS = 10_000;

const watchId = z.uuid();

/**
 * Keeps each configured source's run going for as long as Auni is awake, inside the job runner, so
 * only the Auni holding its lock watches. A sleep or a stop aborts it and the cron starts it again;
 * a saved setting ends it and starts it again at once, since which sources are set up is read as
 * it starts. Each source catches up from its cursor's `since`. It holds one of the runner's slots
 * throughout.
 */
export const sourcesJob = defineJob({
  kind: jobKind("sources", z.object({})),
  every: 10_000,
  endsOnSleep: true,
  run: (_data, { signal }) => untilSettingsChange(signal, runSources),
});

/** What sourcesJob runs; tests call it directly. */
export async function runSources(signal: AbortSignal): Promise<void> {
  const running = sources(offered()).filter(({ source }) => source.configured());
  await Promise.all(
    running.map(({ about }) =>
      keepRunning(`watching ${about.name}`, (stop) => runSource(about.id, stop), signal),
    ),
  );
}

/**
 * Records a source's fires, each against its own watch, for triage to judge. A fire naming a
 * watch that isn't this source's is dropped: one source can never speak for another's watches.
 */
export async function recordSourceFires(
  sourceId: string,
  fires: readonly SourceFire[],
): Promise<FireRecorded[]> {
  const installed = sourceById(sourceId);
  if (!installed) throw new Error(`No source named ${sourceId}.`);
  const recorded: FireRecorded[] = [];
  for (const fire of fires) {
    const [automation] = watchId.safeParse(fire.watchId).success
      ? await db
          .select()
          .from(automations)
          .where(and(eq(automations.id, fire.watchId), eq(automations.source, sourceId)))
      : [];
    if (!automation) {
      console.warn(`${sourceId} fired for a watch it doesn't keep`, fire.watchId);
      recorded.push("ignored");
      continue;
    }
    recorded.push(await recordFire({ automation, fire }));
  }
  return recorded;
}

/** A source's watches that are watching now, as it sees them. */
async function sourceWatches(sourceId: string): Promise<SourceWatch[]> {
  const rows = await db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.source, sourceId),
        eq(automations.status, "active"),
        or(isNull(automations.expiresAt), gt(automations.expiresAt, new Date())),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    condition: row.condition,
    ref: row.sourceRef,
    since: row.createdAt,
  }));
}

/** Where a source's run got to, and when it got there. */
export async function loadCursor(
  sourceId: string,
): Promise<{ readonly cursor: string; readonly savedAt: Date } | undefined> {
  const [row] = await db.select().from(sourceCursors).where(eq(sourceCursors.source, sourceId));
  return row;
}

async function saveCursor(sourceId: string, cursor: string): Promise<void> {
  const savedAt = new Date();
  await db
    .insert(sourceCursors)
    .values({ source: sourceId, cursor, savedAt })
    .onConflictDoUpdate({ target: sourceCursors.source, set: { cursor, savedAt } });
}

/**
 * Runs one source's `run` until `signal` aborts or the run ends: each batch's fires are recorded,
 * then its cursor saved, so a fire is never lost to a crash between them, only told again (under
 * the same id, Source's promise) and recorded once. It throws when the run or a recording fails;
 * runSources starts it again after a pause, and the source catches up from the cursor last saved.
 * Its watches are read again as soon as one starts or changes, and every so often besides.
 */
export async function runSource(
  sourceId: string,
  signal: AbortSignal,
  refreshMs = WATCHES_REFRESH_MS,
): Promise<void> {
  const source = sourceById(sourceId)?.source;
  if (!source) throw new Error(`No source ${sourceId}.`);
  const saved = await loadCursor(sourceId);
  let watches = await sourceWatches(sourceId);
  // Reads can finish out of order; only the latest one asked for is kept.
  let asked = 0;
  async function refresh(): Promise<readonly SourceWatch[]> {
    const ask = ++asked;
    const fresh = await sourceWatches(sourceId);
    if (ask === asked) watches = fresh;
    return fresh;
  }
  const reread = () =>
    void refresh().catch((error: unknown) =>
      console.error(`${sourceId}'s watches not read again`, error),
    );
  const every = setInterval(reread, refreshMs);
  watchesChanged.on(sourceId, reread);
  try {
    const batches = source.run({
      watches: () => watches,
      refresh,
      cursor: saved?.cursor ?? null,
      since: saved?.savedAt ?? null,
      signal,
    });
    for await (const batch of batches) {
      await recordSourceFires(sourceId, batch.fires);
      await saveCursor(sourceId, batch.cursor);
      if (signal.aborted) break;
    }
  } finally {
    clearInterval(every);
    watchesChanged.off(sourceId, reread);
  }
}
