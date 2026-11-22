import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";

import { db, notifications, openSession } from "../db/client.ts";
import { jobs as jobsTable, type JobOutcome, type JobRow } from "../db/schema.ts";
import { theWallet } from "../apps/registry.ts";
import { holderName } from "../running.ts";
import { JOBS_CHANNEL, toTextArray, type Job, type JobRun } from "./queue.ts";

// Runs the jobs table (see queue.ts). One runner per database: it holds a lock for its whole
// life, so a job marked started that this runner isn't running is cut off (at boot, by a process
// that died; later, by a write that failed), and its kind's cutShort decides what becomes of it.
// Jobs sharing a lane run one after another.
//
// The lock lasts as long as the Postgres session that took it, so it sits on a session of its
// own that nothing retires (db/session.ts), and the runner takes each job through that session:
// a job can't be taken without the lock. If the session is ever lost (Postgres restarted, the
// machine slept through its connection), the runner hears at once, ends what only one Auni may
// run, and takes nothing until it holds the lock again on a new session.

/** The most jobs running at once. */
const MAX_RUNNING = 16;
/** The longest the runner waits without looking, in case it missed a notification. */
const POLL_MS = 30_000;
/** How long stop() waits for running jobs (a send in flight) before letting go. */
const DRAIN_MS = 120_000;
/** A timer firing this much later than set means the process was frozen: the machine slept. */
const SLEEP_GAP_MS = 30_000;
/** How often a runner that lost its lock asks for it again. */
const RETAKE_MS = 1_000;

/** How long before a job that threw runs again: 10s, 40s, 160s, then every 10 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(10_000 * 4 ** (attempt - 1), 600_000);
}

export class AlreadyRunning extends Error {
  constructor() {
    super("Auni is already running on this database. Stop that one first.");
  }
}

/** An Auni stopping on this database still holds its runner after the longest it may take. */
export class StillStopping extends Error {
  constructor() {
    super(
      "The Auni that was stopping on this database still hasn't finished after two and a half minutes. Wait for it, or press Ctrl-C again where it runs to stop it at once, then start Auni again.",
    );
  }
}

/** Longest an Auni that is stopping may hold the runner: its jobs' drain, and a margin to let go. */
const STOPPING_MS = DRAIN_MS + 30_000;

/**
 * Starts running `jobs` once this database's runner is free. Held by an Auni that still serves
 * (`serving`), it is a running Auni, so this throws AlreadyRunning. Held by one that no longer
 * serves, it is an Auni stopping, whose running jobs (a send in flight) get up to DRAIN_MS to
 * finish: so this waits for it, saying so once (`onWait`), rather than say Auni runs while it is
 * going away. One still held after STOPPING_MS throws StillStopping.
 */
export async function startRunnerWhenFree(
  jobs: readonly Job<unknown>[],
  serving: () => Promise<boolean>,
  {
    onWait,
    everyMs = 1_000,
    mostMs = STOPPING_MS,
  }: { readonly onWait?: () => void; readonly everyMs?: number; readonly mostMs?: number } = {},
): Promise<Runner> {
  const until = Date.now() + mostMs;
  for (let waited = false; ; waited = true) {
    try {
      return await startRunner(jobs);
    } catch (error) {
      if (!(error instanceof AlreadyRunning) || (await serving())) throw error;
      if (Date.now() >= until) throw new StillStopping();
      if (!waited) onWait?.();
    }
    await sleep(everyMs);
  }
}

export interface Runner {
  /** Stops taking jobs, ends turns, waits for the rest (a send in flight), and lets go. */
  stop(): Promise<void>;
}

interface Rearm {
  readonly error?: unknown;
  readonly retry?: boolean;
}

type Session = ReturnType<typeof openSession>;

interface Running {
  readonly job: Job<unknown>;
  readonly abort: AbortController;
  readonly done: Promise<void>;
}

/**
 * Takes this database's runner lock on a session of its own, named for this process so another
 * command can say which Auni runs and stop it (running.ts); null when another holds it. `lost`
 * is called if the session closes, and the lock with it. An Auni handed over to another machine
 * holds it and runs nothing (handover/), so it still counts as the one running here.
 */
export async function takeRunnerLock(lost: () => void): Promise<Session | null> {
  const session = openSession(lost);
  const [held] = await session.conn
    .execute<{ ok: boolean }>(
      sql`select set_config('application_name', ${holderName()}, false) as named,
                 pg_try_advisory_lock(hashtext('auni:runner')) as ok`,
    )
    .catch(async (error: unknown) => {
      await session.close();
      throw error;
    });
  if (held?.ok) return session;
  await session.close();
  return null;
}

/** Starts running `jobs`; throws AlreadyRunning when another runner has this database. */
export async function startRunner(
  jobs: readonly Job<unknown>[],
  options: { readonly sleepGapMs?: number } = {},
): Promise<Runner> {
  const byKind = new Map(jobs.map((job) => [job.kind.name, job]));
  const kinds = toTextArray([...byKind.keys()]);

  const running = new Map<string, Running>();
  let stopping = false;
  let poked = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    poked = true;
    wake?.();
  };
  /** Ends what the runner may end at any time and start again: a turn, a loop that listens. */
  const endTurns = (why: string) => {
    for (const { job, abort } of running.values()) if (job.endsOnSleep) abort.abort(why);
  };

  /** The session that holds the runner's lock; null while this runner doesn't hold it. */
  let lock = null as Session | null;
  /** Takes the lock on a session of its own; false when another runner holds it. */
  const takeLock = async (): Promise<boolean> => {
    const session: Session | null = await takeRunnerLock(() => {
      if (lock !== session) return;
      lock = null;
      console.error(
        "Auni's job runner lost its lock on the database: the connection holding it closed. It starts no job until it holds the lock again.",
      );
      // Another Auni may take the runner meanwhile, so what only one may run ends now.
      endTurns("lost the runner's lock");
      poke();
    });
    lock = session;
    return lock !== null;
  };
  if (!(await takeLock())) throw new AlreadyRunning();

  /**
   * Ends a run, unless a debounced enqueue asked for it again while it ran, pushing it past when
   * it started (see queue.ts): then it is queued for that time instead. One statement, so an ask
   * that comes as it ends is never lost.
   */
  const askedAgain = sql`${jobsTable.runAt} > ${jobsTable.startedAt}`;
  const finish = (id: string, outcome: JobOutcome, error?: unknown) =>
    db
      .update(jobsTable)
      .set({
        startedAt: sql`case when ${askedAgain} then null else ${jobsTable.startedAt} end`,
        finishedAt: sql`case when ${askedAgain} then null else now() end`,
        outcome: sql`case when ${askedAgain} then null else ${outcome}::text end`,
        attempts: sql`case when ${askedAgain} then 0 else ${jobsTable.attempts} end`,
        error: error === undefined ? null : said(error),
      })
      .where(eq(jobsTable.id, id));
  /** Queues it again: the same run tried again (`retry`), or its next run, counting afresh. */
  const rearm = (id: string, inMs: number, { error, retry = false }: Rearm = {}) =>
    db
      .update(jobsTable)
      .set({
        startedAt: null,
        runAt: sql`now() + make_interval(secs => ${inMs / 1000})`,
        error: error === undefined ? null : said(error),
        ...(retry ? {} : { attempts: 0 }),
      })
      .where(eq(jobsTable.id, id));
  const runOf = (row: JobRow, signal: AbortSignal): JobRun => ({
    id: row.id,
    createdAt: row.createdAt,
    attempts: row.attempts,
    signal,
  });

  /** A run cut short: run again when its kind says so, else ended. */
  const cutShort = async (
    row: JobRow,
    job: Job<unknown>,
    why: "threw" | "crashed",
    error: unknown,
  ) => {
    const verdict = job.cutShort
      ? await job.cutShort(job.kind.data.parse(row.data), runOf(row, AbortSignal.abort()), why)
      : why === "crashed"
        ? "rerun"
        : undefined;
    if (verdict === "rerun")
      await rearm(row.id, why === "threw" ? backoffMs(row.attempts) : 0, { error, retry: true });
    else await finish(row.id, why === "threw" ? "failed" : "interrupted", error);
  };

  const execute = async (row: JobRow, job: Job<unknown>, signal: AbortSignal): Promise<void> => {
    try {
      const result = await job.run(job.kind.data.parse(row.data), runOf(row, signal));
      if (result) await rearm(row.id, result.again);
      else if (job.every) await rearm(row.id, job.every);
      else await finish(row.id, "done");
    } catch (error) {
      console.error(`job ${row.kind} ${row.id} threw (run ${row.attempts})`, error);
      try {
        if (row.attempts <= (job.retries ?? 0))
          await rearm(row.id, backoffMs(row.attempts), { error, retry: true });
        // A cron goes on to its next run, whatever this one did.
        else if (job.every) await rearm(row.id, job.every, { error });
        else await cutShort(row, job, "threw", error);
      } catch (failure) {
        // Left started, so the loop settles it as cut off once the database answers.
        console.error(`job ${row.kind} ${row.id} couldn't be marked`, failure);
      }
    }
  };

  /**
   * The earliest job due whose lanes are free, marked started. Asked through the session that
   * holds the lock, so no job is taken without it: with the session lost, this throws. A job
   * this runner is still running is never taken again, whatever its row says: only another
   * runner could have queued it again, having taken the lock while this one had lost it.
   */
  const claim = async (session: Session): Promise<JobRow | null> => {
    const ours = [...running.keys()];
    const [row] = await session.conn
      .update(jobsTable)
      .set({ startedAt: sql`now()`, attempts: sql`${jobsTable.attempts} + 1` })
      .where(
        eq(
          jobsTable.id,
          sql`(select queued.id from jobs queued
            where queued.started_at is null and queued.finished_at is null
              and queued.run_at <= now() and queued.kind = any(${kinds})
              and queued.id::text <> all(${toTextArray(ours)})
              and not exists (select 1 from jobs busy
                where busy.started_at is not null and busy.finished_at is null
                  and busy.lanes && queued.lanes)
            order by queued.run_at, queued.created_at
            limit 1)`,
        ),
      )
      .returning();
    return row ?? null;
  };

  const start = (row: JobRow) => {
    const job = byKind.get(row.kind)!;
    const abort = new AbortController();
    const done = execute(row, job, abort.signal).finally(() => {
      running.delete(row.id);
      poke();
    });
    running.set(row.id, { job, abort, done });
  };

  /**
   * How long until a job could start, at most POLL_MS. One due whose lanes are busy waits for the
   * job holding them, whose end pokes the loop, as does any end while every slot is taken. One
   * due whose lanes are free came due since claim looked, so the loop looks again at once: left
   * out, as a job just rearmed a few milliseconds ahead often is by then, it would wait the poll.
   */
  const untilNext = async (): Promise<number> => {
    if (running.size >= MAX_RUNNING) return POLL_MS;
    const [next] = await db.execute<{ ms: string | null }>(sql`
      select extract(epoch from min(queued.run_at) - now()) * 1000 as ms from jobs queued
      where queued.started_at is null and queued.finished_at is null
        and queued.kind = any(${kinds})
        and not (queued.run_at <= now() and exists (select 1 from jobs busy
          where busy.started_at is not null and busy.finished_at is null
            and busy.lanes && queued.lanes))`);
    return next?.ms == null ? POLL_MS : Math.min(Math.max(Number(next.ms), 0) + 5, POLL_MS);
  };

  /** Waits `ms`, or until the loop is poked. */
  const nap = async (ms: number) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  };

  const loop = async () => {
    while (!stopping) {
      poked = false;
      try {
        if (!lock && !(await takeLock())) {
          await nap(RETAKE_MS);
          continue;
        }
        await settleOrphans("Its end couldn't be recorded, so it counts as cut off.");
        let row: JobRow | null;
        while (!stopping && lock && running.size < MAX_RUNNING && (row = await claim(lock)))
          start(row);
        const wait = await untilNext();
        if (stopping || poked) continue;
        await nap(wait);
      } catch (error) {
        console.error("the job runner couldn't read its queue", error);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  };

  /**
   * Settles each job marked started that this runner isn't running: no other runner can be (the
   * lock), so its run was cut off, by a process that died or by the write that would have ended
   * it failing. It counts as crashed, whatever its run got through, as a crash after it would.
   * Throws while the database can't be written, and the loop tries again.
   *
   * What this runner is running is taken before the read: a job may end while the read is in
   * flight, leaving `running` but still marked started in what the read returns. Only the loop
   * starts jobs, so none starts in between, and one that ended unrecorded is settled next pass.
   */
  const settleOrphans = async (why: string) => {
    const ours = new Set(running.keys());
    const orphans = await db
      .select()
      .from(jobsTable)
      .where(and(isNotNull(jobsTable.startedAt), isNull(jobsTable.finishedAt)));
    for (const row of orphans) {
      if (ours.has(row.id)) continue;
      const job = byKind.get(row.kind);
      try {
        if (job) await cutShort(row, job, "crashed", why);
        else await finish(row.id, "interrupted", "Nothing runs this kind of job any more.");
      } catch (error) {
        console.error(`job ${row.kind} ${row.id}, cut off midway, wasn't settled`, error);
        await finish(row.id, "interrupted", error);
      }
    }
  };

  /** Boot: every job marked started belonged to a process that is gone. */
  const recover = async () => {
    await settleOrphans("Auni stopped while this ran.");
    for (const job of jobs) {
      if (job.every)
        await db
          .insert(jobsTable)
          .values({ kind: job.kind.name, key: `cron:${job.kind.name}`, data: {} })
          .onConflictDoNothing();
    }
    // What the wallet signed that no node answered for goes out now, the same bytes.
    await theWallet()
      .resend?.()
      .catch((error: unknown) => console.error("signed sends weren't resent", error));
  };

  let listening: { unlisten(): Promise<void> };
  try {
    await recover();
    listening = await notifications.listen(JOBS_CHANNEL, poke);
  } catch (error) {
    await lock?.close();
    throw error;
  }

  // A frozen process (a sleeping machine, a stopped one) wakes to dead connections, so a turn
  // running then ends, rather than hang; anything overdue simply runs now.
  const gap = options.sleepGapMs ?? SLEEP_GAP_MS;
  const tick = Math.min(5_000, gap / 3);
  let ticked = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    if (now - ticked > tick + gap) {
      console.log("Auni was asleep: ending the turns that were running");
      endTurns("slept");
      poke();
    }
    ticked = now;
  }, tick);

  const looping = loop();
  return {
    async stop() {
      stopping = true;
      clearInterval(ticker);
      poke();
      await looping;
      endTurns("stopped");
      await Promise.race([
        Promise.all([...running.values()].map(({ done }) => done)),
        new Promise((resolve) => setTimeout(resolve, DRAIN_MS).unref()),
      ]);
      await listening.unlisten();
      // Closing the session lets go of the lock.
      await lock?.close();
    },
  };
}

function said(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
