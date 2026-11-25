import { sql } from "drizzle-orm";
import { z } from "zod";

import { watchFireSchema, type WatchFire } from "../conversation/history.ts";
import { db } from "../db/client.ts";
import { jobKind, type Executor } from "./queue.ts";

// Every kind of job something queues, with what it carries. What each does is in its own file,
// listed in jobs/index.ts.

/** One turn of a thread: a message the owner sent, or something they didn't type. */
export const turnKind = jobKind(
  "turn",
  z.union([
    z.object({ threadId: z.uuid(), messageId: z.uuid() }),
    z.object({
      threadId: z.uuid(),
      reason: z.string().min(1).max(4_000),
      fires: z.array(watchFireSchema).min(1).optional(),
      briefed: z.array(z.uuid()).min(1).optional(),
    }),
  ]),
  // One turn a thread at a time: a message sent mid-turn waits behind it.
  ({ threadId }) => [`thread:${threadId}`],
);

/**
 * Wakes a thread so the agent learns an outcome and adapts, e.g. `wakeThread(id, "Your $50
 * NVDA buy filled at $182.10")`. A wake that may be asked for again for the same cause passes a
 * `key`, so it starts one turn. Pass `tx` to wake only if that transaction commits. What it
 * tells of is marked told only once an answer that didn't fail is kept (conversation/turn.ts),
 * and a turn that fails before doing anything runs again, so a wake is never lost.
 */
export async function wakeThread(
  threadId: string,
  reason: string,
  options: {
    readonly key?: string;
    /** The watch fires it tells of, so its answer is recorded as their outcome. */
    readonly fires?: readonly WatchFire[];
    /** The fires a daily brief tells of, marked briefed with its answer. */
    readonly briefed?: readonly string[];
    readonly tx?: Executor;
  } = {},
): Promise<void> {
  const { key, fires, briefed, tx = db } = options;
  await turnKind.enqueue(
    tx,
    {
      threadId,
      reason: reason.slice(0, 4_000),
      ...(fires?.length ? { fires: [...fires] } : {}),
      ...(briefed?.length ? { briefed: [...briefed] } : {}),
    },
    key ? { key } : {},
  );
}

/**
 * A thread's fires waiting to be judged before any wakes it (automations/triage.ts). Queued
 * debounced under `triage:<thread>`, so fires landing close together are judged in one run.
 */
export const triageKind = jobKind("triage", z.object({ threadId: z.uuid() }), ({ threadId }) => [
  `triage:${threadId}`,
]);

/**
 * A turn's answer to send on a channel (channels/hub.ts): the message stored with it, or no id for
 * a turn the owner's message started that failed with nothing to show. One channel's answers go
 * out one at a time, in the order they were queued.
 */
export const deliverKind = jobKind(
  "deliver",
  z.object({
    channel: z.string().min(1),
    threadId: z.uuid(),
    messageId: z.uuid().optional(),
    replyTo: z.string().optional(),
  }),
  ({ channel }) => [`channel:${channel}`],
);

/** A move to run once; no two sharing either lane run at once (see executionKeys). */
export const actionKind = jobKind(
  "action",
  z.object({ actionId: z.uuid(), lane: z.string().min(1), holding: z.string().min(1) }),
  ({ lane, holding }) => [lane, holding],
);

/** Money a move sent across to another network or venue, watched until it lands. */
export const landingKind = jobKind("landing", z.object({ actionId: z.uuid() }));

/** A proposal to move on to its next stage; one at a time a proposal. */
export const proposalKind = jobKind(
  "proposal",
  z.object({ proposalId: z.uuid() }),
  ({ proposalId }) => [`proposal:${proposalId}`],
);

/** A new chat's starting points, written from what Auni sees now (conversation/starting-points.ts). */
export const startingPointsKind = jobKind("starting-points", z.object({}), () => [
  "starting-points",
]);

/**
 * How long starting points stand. They quote what's true now ("How is my $19.97 split right
 * now?", "Why is MON down 2.6% today?"), which a trade or an hour's market changes: kept for a
 * day, a chip offered a wallet total from before the owner's last eight moves.
 */
const STARTING_POINTS_FRESH_MS = 60 * 60_000;

const justSavedStartingPointsJobs = new Map<string, number>();
const SAVED_JOB_GRACE_MS = 10_000;

/**
 * Records that `jobId` has just written fresh starting points before the runner stamps
 * `finished_at`, so an immediate SSE refetch sees `pending: false` unless a follow-up refresh
 * job was queued or this job was debounced to run again.
 */
export function markStartingPointsJobSaved(jobId: string): void {
  const now = Date.now();
  justSavedStartingPointsJobs.set(jobId, now + SAVED_JOB_GRACE_MS);
  for (const [id, until] of justSavedStartingPointsJobs) {
    if (until <= now) justSavedStartingPointsJobs.delete(id);
  }
}

/** Whether a starting-points generation job is still pending (excluding a job that just saved and isn't debounced to rerun). */
async function hasPendingStartingPoints(executor: Executor): Promise<boolean> {
  const now = Date.now();
  const savedIds: string[] = [];
  for (const [id, until] of justSavedStartingPointsJobs) {
    if (until > now) savedIds.push(id);
    else justSavedStartingPointsJobs.delete(id);
  }
  const rows =
    savedIds.length > 0
      ? await executor.execute(
          sql`select 1 from jobs where kind = ${startingPointsKind.name} and finished_at is null and (not (id::text = any(array[${sql.join(
            savedIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[])) or (started_at is not null and run_at > started_at)) limit 1`,
        )
      : await executor.execute(
          sql`select 1 from jobs where kind = ${startingPointsKind.name} and finished_at is null limit 1`,
        );
  return rows.length > 0;
}

/**
 * Queues new starting points when none are saved (`savedAt` null) or those saved are past
 * STARTING_POINTS_FRESH_MS; true when a generation is already pending or just queued, so stale
 * points are hidden until the refresh lands.
 */
export async function refreshStartingPoints(
  executor: Executor,
  savedAt: Date | null,
): Promise<boolean> {
  if (await hasPendingStartingPoints(executor)) return true;
  if (savedAt && Date.now() - savedAt.getTime() < STARTING_POINTS_FRESH_MS) return false;
  await startingPointsKind.enqueue(
    executor,
    {},
    { key: `starting-points:${savedAt?.toISOString() ?? "none"}` },
  );
  return true;
}

/**
 * Forces fresh starting points right now (e.g. after onboarding, signal/profile updates, or a
 * manual Refresh click). With `reusePending`, an already queued or running job is reused instead
 * of scheduling another pass.
 */
export async function forceRefreshStartingPoints(
  executor: Executor,
  options: { readonly reusePending?: boolean } = {},
): Promise<void> {
  if (options.reusePending && (await hasPendingStartingPoints(executor))) return;
  await startingPointsKind.enqueue(executor, {}, { key: "starting-points:refresh", debounceMs: 1 });
}

/** Refreshes owner personalization signals (X handle + watched wallets) and then starting points. */
export const signalsKind = jobKind(
  "signals",
  z.object({ replaceSummary: z.boolean().optional() }),
  () => ["signals"],
);

/** Queues a background refresh of the owner's connected signals. */
export async function enqueueSignalsRefresh(
  executor: Executor,
  options: { readonly replaceSummary?: boolean } = {},
): Promise<void> {
  await signalsKind.enqueue(executor, options);
}

/** A reading of the owner's portfolio (see askForReading). */
export const readingKind = jobKind("reading", z.object({}));

/** A token they held quietly as Other, as told once Auni recognises it. */
export const recognisedSchema = z.object({
  /** Its address, or Solana mint, to act on it by. */
  instrument: z.string(),
  /** As its listing names it now. */
  name: z.string(),
  /** Whole units held: "1200.5". */
  amount: z.string(),
  usdValue: z.string(),
});

/** The most tokens one wake tells of: each one's line and a few of its moves fit in a wake. */
export const TOLD_PER_WAKE = 8;

/** Tokens on one network that Auni just began counting, to tell them of. */
export const foundKind = jobKind(
  "found",
  z.object({
    chain: z.string(),
    tokens: z.array(recognisedSchema).min(1).max(TOLD_PER_WAKE),
  }),
);
