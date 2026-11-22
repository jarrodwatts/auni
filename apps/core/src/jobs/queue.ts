import { sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "../db/client.ts";

// Background work as rows in Postgres (the jobs table), run by jobs/runner.ts. Queue a job in
// the transaction that makes it needed, and the two commit together: an allowed card always has
// its move queued, a stored message its turn.

/** The database, or a transaction on it. */
export type Executor = Pick<Database, "execute">;

/** The channel enqueue pings, so the runner looks the moment a job commits. */
export const JOBS_CHANNEL = "auni_jobs";

/** One run of a job, as its `run` sees it. */
export interface JobRun {
  readonly id: string;
  /** When it was first queued; a re-armed job (`again`, `every`) keeps it. */
  readonly createdAt: Date;
  /** Which run this is: 1, then one more for each time it was tried again since it was queued. */
  readonly attempts: number;
  /** Fires when the job must stop: a sleep or a shutdown, for jobs that end on one. */
  readonly signal: AbortSignal;
}

/**
 * A kind of job, as anyone queueing one sees it: its name, its data, and its lanes. What it does
 * is its Job, which only the runner's list (jobs/index.ts) imports, so code that queues a job
 * never imports the code the job runs.
 */
export interface JobKind<D> {
  readonly name: string;
  readonly data: z.ZodType<D>;
  enqueue(executor: Executor, data: D, options?: EnqueueOptions): Promise<void>;
}

interface EnqueueOptions {
  /** Queued once per key; a second enqueue with it does nothing, unless it debounces. */
  readonly key?: string;
  /**
   * With a key: each enqueue pushes the job this far out, so a burst runs it once, after the
   * last. One running runs again then, once it ends; one finished is queued again.
   */
  readonly debounceMs?: number;
  /** Not run before this, as a move a card showed coming days later (ExecuteResult.later). */
  readonly at?: Date;
}

/** A kind of job; two whose `lanes` overlap never run at the same time. */
export function jobKind<D>(
  name: string,
  data: z.ZodType<D>,
  lanes?: (data: D) => readonly string[],
): JobKind<D> {
  return {
    name,
    data,
    enqueue: (executor, values, { key, debounceMs, at } = {}) =>
      enqueue(executor, name, data.parse(values), lanes?.(values) ?? [], key, debounceMs, at),
  };
}

/**
 * What a kind of job does when it runs, and when a run is cut short. Methods rather than
 * function-typed fields, so a Job<{ actionId: string }> is a Job<unknown> in the runner's list.
 */
export interface Job<D> {
  readonly kind: JobKind<D>;
  /** Returning `again` runs it once more in that many milliseconds, as the same job. */
  run(data: D, job: JobRun): Promise<void | { readonly again: number }>;
  /** Times a throw is tried again, backing off (see backoffMs). Only for work safe to repeat. */
  readonly retries?: number;
  /** A cron: one row, run every this many milliseconds, so missed runs come to one. */
  readonly every?: number;
  /** Aborted when the machine sleeps and when Auni stops (a turn), rather than waited for. */
  readonly endsOnSleep?: true;
  /**
   * A run that threw past its retries, or that a crash or kill cut off midway. Return "rerun"
   * to run it again. Unset, a crashed run is run again and one that threw is failed.
   */
  cutShort?(data: D, job: JobRun, why: "threw" | "crashed"): Promise<"rerun" | void>;
}

/** Infers a Job's data from its kind. */
export function defineJob<D>(job: Job<D>): Job<D> {
  return job;
}

async function enqueue(
  executor: Executor,
  kind: string,
  data: unknown,
  lanes: readonly string[],
  key: string | undefined,
  debounceMs: number | undefined,
  at: Date | undefined,
): Promise<void> {
  // A debounced job's time is the clock's, not its transaction's start, so one asked for while it
  // runs is due after it started, which is how the runner knows to run it again (see finish).
  const runAt = debounceMs
    ? sql`clock_timestamp() + make_interval(secs => ${debounceMs / 1000})`
    : at
      ? sql`${at.toISOString()}::timestamptz`
      : sql`now()`;
  const running = sql`jobs.started_at is not null and jobs.finished_at is null`;
  const onConflict = debounceMs
    ? sql`on conflict (key) do update set run_at = excluded.run_at,
        started_at = case when ${running} then jobs.started_at end,
        attempts = case when ${running} then jobs.attempts else 0 end,
        finished_at = null, outcome = null, error = null`
    : sql`on conflict (key) do nothing`;
  await executor.execute(sql`
    insert into jobs (kind, key, data, lanes, run_at)
    values (${kind}, ${key ?? null}, ${JSON.stringify(data)}::jsonb,
      ${toTextArray(lanes)}, ${runAt})
    ${onConflict}`);
  // Postgres delivers a notification only when its transaction commits, so the runner wakes
  // exactly when the job becomes visible to it.
  await executor.execute(sql`select pg_notify(${JOBS_CHANNEL}, '')`);
}

/**
 * Cancels the jobs in `lane` that haven't started, as a stopped thread's queued turns. One
 * running is the caller's to stop.
 */
export async function cancelLane(executor: Executor, lane: string): Promise<void> {
  await executor.execute(sql`
    update jobs set finished_at = now(), outcome = 'cancelled'
    where finished_at is null and started_at is null and ${lane} = any(lanes)`);
}

/** A text[] parameter, which a plain JS array doesn't bind as. */
export function toTextArray(values: readonly string[]) {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}
