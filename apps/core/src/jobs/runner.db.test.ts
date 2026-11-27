import { setTimeout as sleep } from "node:timers/promises";

import { eq, sql, type SQL } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { db } from "../db/client.ts";
import { jobs, type JobRow } from "../db/schema.ts";
import { env } from "../env.ts";
import { pruneJob } from "./prune.ts";
import { cancelLane, defineJob, jobKind, type Job } from "./queue.ts";
import {
  AlreadyRunning,
  backoffMs,
  startRunner,
  startRunnerWhenFree,
  StillStopping,
  type Runner,
} from "./runner.ts";

let runner: Runner | undefined;
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const start = async (kinds: readonly Job<unknown>[], options = {}) => {
  runner = await startRunner(kinds, options);
  return runner;
};

async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

const rows = (kind: string): Promise<JobRow[]> =>
  db.select().from(jobs).where(eq(jobs.kind, kind)).orderBy(jobs.createdAt);
const allDone = async (kind: string, count: number) => {
  const all = await rows(kind);
  return all.length === count && all.every((row) => row.outcome === "done");
};

/** A job that records each run, in lanes the data names, taking `ms` each. */
function recorder(name: string, ms = 0) {
  const runs: { readonly name: string; readonly start: number; end: number }[] = [];
  const job = defineJob({
    kind: jobKind(
      name,
      z.object({ name: z.string(), lanes: z.array(z.string()) }),
      ({ lanes }) => lanes,
    ),
    run: async ({ name }) => {
      const run = { name, start: performance.now(), end: Infinity };
      runs.push(run);
      await sleep(ms);
      run.end = performance.now();
    },
  });
  return { job, runs };
}

describe("enqueue", () => {
  it("queues a key once", async () => {
    const { job } = recorder("once");
    await job.kind.enqueue(db, { name: "a", lanes: [] }, { key: "k" });
    await job.kind.enqueue(db, { name: "b", lanes: [] }, { key: "k" });
    expect((await rows("once")).map((row) => row.data)).toEqual([{ name: "a", lanes: [] }]);
  });

  // A key is a message id or a wake's id: a turn it ran once must never run again.
  it("never runs a key's job twice, even once it finished", async () => {
    const { job, runs } = recorder("once-done");
    await job.kind.enqueue(db, { name: "a", lanes: [] }, { key: "done-k" });
    await start([job]);
    await until(() => allDone("once-done", 1));
    await job.kind.enqueue(db, { name: "b", lanes: [] }, { key: "done-k" });
    await db.execute(sql`select pg_notify('auni_jobs', '')`);
    await sleep(200);
    expect(runs.map(({ name }) => name)).toEqual(["a"]);
    expect(await rows("once-done")).toEqual([
      expect.objectContaining({ data: { name: "a", lanes: [] }, outcome: "done" }),
    ]);
  });

  it("pushes a debounced job out, runs one asked for while it ran again after, and queues one finished again", async () => {
    let runs = 0;
    let release = () => {};
    const job = defineJob({
      kind: jobKind("debounced", z.object({})),
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    await job.kind.enqueue(db, {}, { key: "d", debounceMs: 60_000 });
    const [first] = await rows("debounced");
    await sleep(10);
    await job.kind.enqueue(db, {}, { key: "d", debounceMs: 60_000 });
    const [pushed] = await rows("debounced");
    expect(pushed!.runAt.getTime()).toBeGreaterThan(first!.runAt.getTime());

    await db.update(jobs).set({ runAt: sql`now()` });
    await start([job]);
    await until(async () => (await rows("debounced"))[0]!.startedAt !== null);
    // Asked for while it runs (a move settling mid-reading): it carries on, then runs again.
    await job.kind.enqueue(db, {}, { key: "d", debounceMs: 50 });
    expect((await rows("debounced"))[0]).toMatchObject({ startedAt: expect.any(Date) });
    release();
    await until(() => runs === 2);
    release();
    await until(async () => (await rows("debounced"))[0]!.outcome === "done");
    expect(runs).toBe(2);

    await job.kind.enqueue(db, {}, { key: "d", debounceMs: 60_000 });
    expect((await rows("debounced"))[0]).toMatchObject({
      startedAt: null,
      finishedAt: null,
      outcome: null,
      attempts: 0,
    });
  });
});

describe("the runner", () => {
  it("never runs two jobs sharing a lane at once, and runs them all", async () => {
    const { job, runs } = recorder("laned", 15);
    const lanes = [["x"], ["y"], ["x", "z"]];
    for (let at = 0; at < 20; at += 1)
      await job.kind.enqueue(db, { name: String(at), lanes: lanes[at % 3]! });
    await start([job]);
    await until(() => allDone("laned", 20), 15_000);

    const laneOf = new Map(runs.map((run) => [run.name, lanes[Number(run.name) % 3]!]));
    for (const a of runs)
      for (const b of runs) {
        if (a === b || !laneOf.get(a.name)!.some((lane) => laneOf.get(b.name)!.includes(lane)))
          continue;
        expect(a.end <= b.start || b.end <= a.start, `${a.name} overlaps ${b.name}`).toBe(true);
      }
  });

  it("runs jobs in lanes of their own side by side", async () => {
    let started = 0;
    let both = () => {};
    const met = new Promise<void>((resolve) => (both = resolve));
    const job = defineJob({
      kind: jobKind("side", z.object({ lane: z.string() }), ({ lane }) => [lane]),
      run: async () => {
        started += 1;
        if (started === 2) both();
        // Each waits for the other: one run at a time would never get here.
        await met;
      },
    });
    await job.kind.enqueue(db, { lane: "a" });
    await job.kind.enqueue(db, { lane: "b" });
    await start([job]);
    await until(() => allDone("side", 2));
  });

  it("cancels a lane's jobs that haven't started, never one running", async () => {
    let release = () => {};
    const job = defineJob({
      kind: jobKind("turnish", z.object({ n: z.number() }), () => ["thread:1"]),
      run: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await job.kind.enqueue(db, { n: 1 });
    await start([job]);
    await until(async () => (await rows("turnish"))[0]?.startedAt != null);
    await job.kind.enqueue(db, { n: 2 });
    await cancelLane(db, "thread:1");
    expect((await rows("turnish")).map((row) => row.outcome)).toEqual([null, "cancelled"]);
    release();
    await until(async () => (await rows("turnish"))[0]!.outcome === "done");
  });

  it("is the only runner on its database", async () => {
    await start([]);
    await expect(startRunner([])).rejects.toBeInstanceOf(AlreadyRunning);
  });

  it("holds its lock for as long as it runs, on a connection the library never retires", async () => {
    // postgres.js closes a connection at 30 to 60 minutes old unless told otherwise: here, at one
    // second. A demo's runner lost its lock that way 56 minutes in, and a second `auni` took its
    // jobs while it still ran them (2026-11-14).
    vi.stubEnv("PGMAX_LIFETIME", "1");
    vi.stubEnv("PGIDLE_TIMEOUT", "1");
    await start([]);
    await sleep(1_500);
    await expect(startRunner([])).rejects.toBeInstanceOf(AlreadyRunning);
  });

  it("takes no job once the session holding its lock is lost, until it holds the lock again", async () => {
    const quiet = silence();
    const { job, runs } = recorder("locked");
    // A turn, which only one Auni may run: it ends when the runner says so.
    let turnEnded: unknown;
    const turn = defineJob({
      kind: jobKind("locked-turn", z.object({})),
      endsOnSleep: true,
      run: (_, { signal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(void (turnEnded = signal.reason))),
        ),
    });
    await turn.kind.enqueue(db, {});
    await start([job, turn]);
    await until(async () => (await rows("locked-turn"))[0]?.startedAt != null);
    // Another Auni waits for the lock, and has it the moment this runner's session ends, as when
    // Postgres restarts under it.
    const other = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      const taken = other`select pg_advisory_lock(hashtext('auni:runner'))`.execute();
      await until(async () => (await lockSessions(false)).length === 1);
      const [holder] = await lockSessions(true);
      await db.execute(sql`select pg_terminate_backend(${holder}::int)`);
      await taken;

      await until(() => turnEnded !== undefined);
      await job.kind.enqueue(db, { name: "queued while another holds the lock", lanes: [] });
      await sleep(1_500);
      expect(runs).toEqual([]);
      expect((await rows("locked"))[0]!.startedAt).toBeNull();
    } finally {
      await other.end();
      quiet();
    }
    // The other Auni is gone, so this one takes the lock again and carries on.
    await until(() => allDone("locked", 1));
  });

  it("never starts a job it is still running, whatever became of its row while its lock was lost", async () => {
    const quiet = silence();
    let runs = 0;
    let release = () => {};
    const job = defineJob({
      kind: jobKind("still-running", z.object({})),
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    await job.kind.enqueue(db, {});
    await start([job]);
    await until(() => runs === 1);
    // The lock is lost, and before this runner has it again another Auni's takes the job for cut
    // off and queues it to run again, then dies.
    const [holder] = await lockSessions(true);
    await db.execute(sql`select pg_terminate_backend(${holder}::int)`);
    await db.update(jobs).set({ startedAt: null, runAt: sql`now()` });
    await until(async () => (await lockSessions(true)).length === 1);
    await db.execute(sql`select pg_notify('auni_jobs', '')`);
    await sleep(500);
    expect(runs).toBe(1);
    release();
    await until(() => allDone("still-running", 1));
    await sleep(200);
    expect(runs).toBe(1);
    quiet();
  });

  it("waits for an Auni that is stopping to let go, rather than say Auni is running", async () => {
    // `auni` started a few seconds after one was stopped said "Auni is already running." and
    // exited, while the one stopping was still finishing a job (2026-11-13).
    const { job, runs } = recorder("finishing", 600);
    await job.kind.enqueue(db, { name: "send", lanes: [] });
    const stopping = await startRunner([job]);
    await until(() => runs.length === 1);
    const stopped = stopping.stop();
    const waits = vi.fn();
    runner = await startRunnerWhenFree([], async () => false, { onWait: waits, everyMs: 50 });
    const started = performance.now();
    await stopped;
    // It started only once the job the other was finishing was done, and said why it waited once.
    expect(runs[0]!.end).toBeLessThanOrEqual(started);
    expect(await allDone("finishing", 1)).toBe(true);
    expect(waits).toHaveBeenCalledOnce();
  });

  it("says Auni is running when the one holding the runner still serves", async () => {
    await start([]);
    await expect(startRunnerWhenFree([], async () => true)).rejects.toBeInstanceOf(AlreadyRunning);
  });

  it("gives up on an Auni that never finishes stopping, and says so", async () => {
    await start([]);
    await expect(
      startRunnerWhenFree([], async () => false, { everyMs: 20, mostMs: 100 }),
    ).rejects.toBeInstanceOf(StillStopping);
  });

  it("runs a job again as the same job when it asks, keeping when it was queued", async () => {
    let runs = 0;
    const created: Date[] = [];
    const job = defineJob({
      kind: jobKind("again", z.object({})),
      run: async (_, run) => {
        runs += 1;
        created.push(run.createdAt);
        if (runs < 3) return { again: 10 };
      },
    });
    await job.kind.enqueue(db, {});
    await start([job]);
    await until(() => allDone("again", 1));
    expect(runs).toBe(3);
    expect(new Set(created.map(Number)).size).toBe(1);
  });

  it("runs a cron that missed three runs once, then waits its interval", async () => {
    let runs = 0;
    const cron = defineJob({
      kind: jobKind("cron-test", z.object({})),
      every: 60_000,
      run: async () => void (runs += 1),
    });
    await db.insert(jobs).values({
      kind: "cron-test",
      key: "cron:cron-test",
      data: {},
      runAt: new Date(Date.now() - 180_000),
    });
    await start([cron]);
    await until(async () => (await rows("cron-test"))[0]!.runAt.getTime() > Date.now());
    await sleep(100);
    expect(runs).toBe(1);
    const [row] = await rows("cron-test");
    expect(row).toMatchObject({ startedAt: null, finishedAt: null });
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now() + 55_000);
  });

  it("makes each cron's row as it starts", async () => {
    const cron = defineJob({
      kind: jobKind("cron-new", z.object({})),
      every: 60_000,
      run: async () => {},
    });
    await start([cron]);
    expect(await rows("cron-new")).toEqual([expect.objectContaining({ key: "cron:cron-new" })]);
  });

  it("backs a throw off, then fails it past its retries, telling its kind", async () => {
    const cut: string[] = [];
    const job = defineJob({
      kind: jobKind("flaky", z.object({})),
      retries: 1,
      run: async () => {
        throw new Error("down");
      },
      cutShort: async (_, __, why) => void cut.push(why),
    });
    await job.kind.enqueue(db, {});
    const quiet = silence();
    await start([job]);
    await until(async () => (await rows("flaky"))[0]!.error === "down");
    const [backedOff] = await rows("flaky");
    expect(backedOff).toMatchObject({ attempts: 1, startedAt: null, outcome: null });
    expect(backedOff!.runAt.getTime() - Date.now()).toBeGreaterThan(backoffMs(1) - 1_000);

    await db.update(jobs).set({ runAt: sql`now()` });
    await db.execute(sql`select pg_notify('auni_jobs', '')`);
    await until(async () => (await rows("flaky"))[0]!.outcome === "failed");
    expect(cut).toEqual(["threw"]);
    quiet();
  });

  // Only work safe to repeat names retries: a move's or a turn's throw is never run again unasked.
  it("fails a throw at once when its kind names no retries, telling its kind", async () => {
    let runs = 0;
    const cut: string[] = [];
    const job = defineJob({
      kind: jobKind("unretried", z.object({})),
      run: async () => {
        runs += 1;
        throw new Error("down");
      },
      cutShort: async (_, __, why) => void cut.push(why),
    });
    await job.kind.enqueue(db, {});
    const quiet = silence();
    await start([job]);
    await until(async () => (await rows("unretried"))[0]!.outcome === "failed");
    expect(runs).toBe(1);
    expect(cut).toEqual(["threw"]);
    expect((await rows("unretried"))[0]).toMatchObject({ attempts: 1, error: "down" });
    quiet();
  });

  it("settles what a dead runner left running, by its kind's rule", async () => {
    const ran: string[] = [];
    const job = (name: string, cutShort?: () => Promise<"rerun" | void>) =>
      defineJob({
        kind: jobKind(name, z.object({})),
        run: async () => void ran.push(name),
        ...(cutShort ? { cutShort } : {}),
      });
    const kinds = [job("plain"), job("rerun", async () => "rerun"), job("never", async () => {})];
    for (const kind of [...kinds.map((each) => each.kind.name), "gone"])
      await db.insert(jobs).values({ kind, data: {}, startedAt: sql`now()`, attempts: 1 });
    await start(kinds);
    await until(async () => ran.length === 2);
    expect(ran.toSorted()).toEqual(["plain", "rerun"]);
    const outcome = async (kind: string) => (await rows(kind))[0]!.outcome;
    await until(async () => (await outcome("rerun")) === "done");
    // Run again as the same run, so its kind can tell a second cut from a first: a turn that
    // brings Auni down each time it runs is run again once, not for ever.
    expect((await rows("rerun"))[0]!.attempts).toBe(2);
    expect(await outcome("never")).toBe("interrupted");
    expect(await outcome("gone")).toBe("interrupted");
  });

  it(
    "settles a run whose end couldn't be recorded, so its lane goes on, without a restart",
    { timeout: 20_000 },
    async () => {
      const quiet = silence();
      // While set, the database refuses to end the job named "first", as in a blip.
      await db.execute(sql`create or replace function auni_test_blip() returns trigger
      language plpgsql as $$ begin
        if old.data->>'name' = 'first' and new.finished_at is not null then raise exception 'blip'; end if;
        if old.data->>'name' = 'first' and new.started_at is null then raise exception 'blip'; end if;
        return new; end $$`);
      try {
        const ran: string[] = [];
        const kind = jobKind("blipped", z.object({ name: z.string() }), () => ["wallet"]);
        const job = defineJob({
          kind,
          run: async ({ name }) => {
            ran.push(name);
            if (name === "first")
              await db.execute(sql`create trigger auni_test_blip before update on jobs
              for each row execute function auni_test_blip()`);
          },
          // As a move's: what it did is its own row's to say, so it is never run again.
          cutShort: async () => {},
        });
        await kind.enqueue(db, { name: "first" });
        await start([job]);
        await until(async () => (await rows("blipped"))[0]?.startedAt != null && ran.length === 1);
        await sleep(100);
        // The blip ends, and another move comes for the same lane.
        await db.execute(sql`drop trigger if exists auni_test_blip on jobs`);
        await kind.enqueue(db, { name: "second" });
        await until(async () => (await rows("blipped")).every((row) => row.finishedAt), 15_000);
        expect(ran).toEqual(["first", "second"]);
        expect((await rows("blipped")).map((row) => row.outcome)).toEqual(["interrupted", "done"]);
      } finally {
        await db.execute(sql`drop trigger if exists auni_test_blip on jobs`);
        await db.execute(sql`drop function if exists auni_test_blip()`);
        quiet();
      }
    },
  );

  it("never takes a job that ends while it looks for cut-off runs for one", async () => {
    const cut: string[] = [];
    let release = () => {};
    const job = defineJob({
      kind: jobKind("racing", z.object({})),
      run: () => new Promise<void>((resolve) => (release = resolve)),
      cutShort: async (_, __, why) => void cut.push(why),
    });
    await job.kind.enqueue(db, {});
    await start([job]);
    await until(async () => (await rows("racing"))[0]?.startedAt != null);
    // The runner's next look for cut-off runs reads the job as running, and the job ends, its
    // end recorded, before that read comes back.
    const select = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementationOnce(
      () =>
        ({
          from: (table: typeof jobs) => ({
            where: async (where: SQL) => {
              const read = await select().from(table).where(where);
              release();
              await until(async () => (await rows("racing"))[0]?.finishedAt != null);
              await sleep(50);
              return read;
            },
          }),
        }) as never,
    );
    await db.execute(sql`select pg_notify('auni_jobs', '')`);
    await until(() => vi.mocked(db.select).mock.calls.length > 0);
    await sleep(300);
    expect(cut).toEqual([]);
    expect((await rows("racing"))[0]!.outcome).toBe("done");
  });

  it("ends a turn when the process was frozen, and only turns", async () => {
    const ended: string[] = [];
    const hold = (kind: string, endsOnSleep: boolean) =>
      defineJob({
        kind: jobKind(kind, z.object({})),
        ...(endsOnSleep ? { endsOnSleep: true as const } : {}),
        run: (_, { signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              ended.push(kind);
              resolve();
            });
            if (!endsOnSleep) setTimeout(resolve, 1_500);
          }),
      });
    const [turn, send] = [hold("hanging-turn", true), hold("slow-send", false)];
    await turn.kind.enqueue(db, {});
    await send.kind.enqueue(db, {});
    await start([turn, send], { sleepGapMs: 300 });
    await until(async () => (await rows("slow-send"))[0]?.startedAt != null);
    await until(async () => (await rows("hanging-turn"))[0]?.startedAt != null);
    // Freezes this process, as a sleeping machine does, past the gap.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    await until(() => allDone("hanging-turn", 1));
    expect(ended).toEqual(["hanging-turn"]);
    await until(() => allDone("slow-send", 1));
  });

  it("shares one drain when stop() is called twice while a job is in flight", async () => {
    let release = () => {};
    let started = false;
    let finished = false;
    const job = defineJob({
      kind: jobKind("shared-drain", z.object({})),
      run: () => {
        started = true;
        return new Promise<void>((resolve) => {
          release = () => {
            finished = true;
            resolve();
          };
        });
      },
    });
    await job.kind.enqueue(db, {});
    const active = await start([job]);
    await until(() => started);

    const first = active.stop();
    const second = active.stop();
    expect(second).toBe(first);

    await sleep(50);
    expect(finished).toBe(false);
    expect(await lockSessions(true)).toHaveLength(1);

    release();
    await Promise.all([first, second]);
    runner = undefined;
    expect(await allDone("shared-drain", 1)).toBe(true);
    expect(await lockSessions(true)).toEqual([]);
  });
});

describe("pruneJob", () => {
  it("forgets jobs finished more than two weeks ago", async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);
    await db.insert(jobs).values([
      { kind: "old", data: {}, finishedAt: daysAgo(15), outcome: "done" },
      { kind: "recent", data: {}, finishedAt: daysAgo(13), outcome: "done" },
      { kind: "open", data: {}, runAt: daysAgo(20) },
    ]);
    await pruneJob.run(
      {},
      { id: "prune", createdAt: new Date(), attempts: 1, signal: AbortSignal.abort() },
    );
    expect(
      (await db.select({ kind: jobs.kind }).from(jobs)).map((row) => row.kind).toSorted(),
    ).toEqual(["open", "recent"]);
  });
});

describe("backoffMs", () => {
  it("waits 10s, 40s, 160s, then 10 minutes", () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([10_000, 40_000, 160_000, 600_000, 600_000]);
  });
});

/** The sessions that hold the runner's lock on this database (`granted`), or wait for it. */
async function lockSessions(granted: boolean): Promise<number[]> {
  const held = await db.execute<{ pid: number }>(sql`
    select locks.pid from pg_locks locks join pg_database on pg_database.oid = locks.database
    where locks.locktype = 'advisory' and locks.granted = ${granted}
      and pg_database.datname = current_database()`);
  return held.map(({ pid }) => pid);
}

/** Quiets the runner's report of a job throwing, for a test that throws on purpose. */
function silence(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}
