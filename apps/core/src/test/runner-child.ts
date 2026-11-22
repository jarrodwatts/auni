// A job runner in a process of its own, for jobs/faults.db.test.ts to kill or freeze and
// running.db.test.ts to stop. It runs core's own jobs (but the crons), or with `sleep`, three of
// its own that say when they run, or with `deaf`, core's, ignoring SIGTERM.
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { jobs } from "../jobs/index.ts";
import { defineJob, jobKind, type Job } from "../jobs/queue.ts";
import { startRunner } from "../jobs/runner.ts";

const say = (line: string): void => void process.stdout.write(`${line}\n`);

/** A turn that hangs until it is ended, a job due a moment from now, and a cron. */
const sleepJobs: readonly Job<unknown>[] = [
  defineJob({
    kind: jobKind("hang", z.object({})),
    endsOnSleep: true,
    run: (_, { signal }) =>
      new Promise<void>((resolve) => {
        say("hang started");
        signal.addEventListener("abort", () => {
          say("hang ended");
          resolve();
        });
      }),
  }),
  defineJob({ kind: jobKind("due", z.object({})), run: async () => say("due ran") }),
  defineJob({
    kind: jobKind("tick", z.object({})),
    every: 2_000,
    run: async () => say("tick ran"),
  }),
];

const sleeping = process.argv[2] === "sleep";
// One that a SIGTERM doesn't stop, as an Auni still finishing a send isn't stopped at once.
if (process.argv[2] === "deaf") process.on("SIGTERM", () => say("still finishing"));
await startRunner(sleeping ? sleepJobs : jobs.filter((job) => !job.every), {
  sleepGapMs: Number(process.env.AUNI_TEST_SLEEP_GAP_MS) || undefined,
});
say("ready");
// Kept alive by the runner; this only stops a child its test forgot.
await sleep(120_000);
process.exit(0);
