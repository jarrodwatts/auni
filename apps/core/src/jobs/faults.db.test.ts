import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onLive, type LiveMessage } from "../conversation/stream.ts";
import { runConversationTurn } from "../conversation/turn.ts";
import { db } from "../db/client.ts";
import { actions, jobs, messages, threads, type JobRow } from "../db/schema.ts";
import { env } from "../env.ts";
import { decideActions, queueExecution } from "../money/actions.ts";
import { theWallet } from "../apps/registry.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { stubRecipe } from "../test/recipe.ts";
import { actionJob } from "./action.ts";
import { turnKind } from "./kinds.ts";
import type { Job } from "./queue.ts";
import { AlreadyRunning, startRunner, type Runner } from "./runner.ts";
import { turnJob } from "./turn.ts";

// Kills a runner in a process of its own (test/runner-child.ts) at each point a crash could cut a
// job short, then starts one here, as Auni starting again would, and checks nothing runs twice
// and everything settles. A point is reached by holding a lock the child's next step waits on.

// Here, as the restarted runner: a move runs a stand-in recipe, and a turn only counts.
let executions = 0;
const buy = stubRecipe({
  execute: async () => {
    executions += 1;
    return { txs: [{ chain: "base", hash: "0xabc" }], fills: [] };
  },
});
vi.mock("../money/recipes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recipeForTool: () => buy,
}));
vi.mock("../money/wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  signerFor: async () => ({}),
}));
vi.mock("../conversation/turn.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runConversationTurn: vi.fn(async () => {}),
}));
const heard: LiveMessage[] = [];
onLive((message) => heard.push(message));

const CHILD = fileURLToPath(new URL("../test/runner-child.ts", import.meta.url));
const CORE = fileURLToPath(new URL("../..", import.meta.url));

let child: { readonly process: ChildProcess; readonly lines: string[] } | undefined;
let runner: Runner | undefined;
const holder = postgres(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });

beforeEach(async () => {
  executions = 0;
  vi.mocked(runConversationTurn).mockClear();
  heard.length = 0;
  await wipe(actions, messages, threads);
});

afterEach(async () => {
  child?.process.kill("SIGKILL");
  child = undefined;
  await runner?.stop();
  runner = undefined;
});

async function until(check: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

/** Starts the child runner and waits for it to say it's ready. */
async function startChild(scenario = "", extraEnv: Record<string, string> = {}) {
  // Node itself, as `auni` runs, so the signal reaches the runner's own process.
  const started = spawn(process.execPath, [CHILD, scenario], {
    cwd: CORE,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines: string[] = [];
  started.stdout!.setEncoding("utf8");
  started.stdout!.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
  child = { process: started, lines };
  await until(() => lines.includes("ready"), 60_000);
  return child;
}

/** SIGKILLs the child, then ends its queries still waiting on the test's lock, as a dead client's would be. */
async function killChild(): Promise<void> {
  const dead = once(child!.process, "exit");
  child!.process.kill("SIGKILL");
  await dead;
  child = undefined;
  await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
}

/** Queries waiting on a lock: the child, stopped at the point the test holds. */
async function waiting(): Promise<number> {
  const [row] = await db.execute<{ count: string }>(sql`select count(*) as count
    from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
  return Number(row?.count ?? 0);
}

/** Holds `lock` (SQL run in an open transaction) until the returned release. */
async function hold(lock: (tx: postgres.Sql) => Promise<unknown>): Promise<() => Promise<void>> {
  const reserved = await holder.reserve();
  await reserved`begin`;
  await lock(reserved);
  return async () => {
    await reserved`rollback`;
    reserved.release();
  };
}

/** Starts the runner here, once the killed one's lock is let go of: Auni starting again. */
async function restart(kinds: readonly Job<unknown>[]): Promise<Runner> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      runner = await startRunner(kinds);
      return runner;
    } catch (error) {
      if (!(error instanceof AlreadyRunning) || attempt > 200) throw error;
      await sleep(50);
    }
  }
}

const jobOf = async (kind: string): Promise<JobRow> =>
  (await db.select().from(jobs).where(eq(jobs.kind, kind)))[0]!;
const actionRow = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0]!;

describe("a runner killed midway", { timeout: 120_000 }, () => {
  it("runs a move once whose job it claimed but not the move", async () => {
    const action = await insertAction({ input: { usd: "10" } });
    const release = await hold(
      (tx) => tx`select id from actions where id = ${action.id} for update`,
    );
    await queueExecution(db, [action]);
    await startChild();
    await until(async () => (await jobOf("action")).startedAt !== null && (await waiting()) > 0);
    await killChild();
    await release();
    expect(await actionRow(action.id)).toMatchObject({ status: "running", startedAt: null });

    await restart([actionJob]);
    await until(async () => (await jobOf("action")).outcome === "done");
    expect(executions).toBe(1);
    expect(await actionRow(action.id)).toMatchObject({ status: "done" });
  });

  it("fails a move it claimed before sending anything, never runs it again, and wakes its thread once", async () => {
    const thread = await insertThread();
    const action = await insertAction({
      threadId: thread.id,
      input: { usd: "10" },
      details: { chain: "base", mint: "0x5555555555555555555555555555555555555555", token: "XYZ" },
    });
    await queueExecution(db, [action]);
    // The move reads whether the token it buys counts yet right after claiming it, before any send.
    const release = await hold((tx) => tx`lock table other_tokens in access exclusive mode`);
    await startChild();
    await until(
      async () => (await actionRow(action.id)).startedAt !== null && (await waiting()) > 0,
    );
    await killChild();
    await release();

    await restart([actionJob, turnJob]);
    await until(async () => (await jobOf("action")).outcome === "interrupted");
    await until(async () => (await jobOf("turn"))?.outcome === "done");
    expect(executions).toBe(0);
    expect(await actionRow(action.id)).toMatchObject({ status: "failed", failureKind: "sent" });
    expect(await queued("turn")).toEqual([
      expect.objectContaining({ key: `action-settled-${action.id}-a1` }),
    ]);
    expect(runConversationTurn).toHaveBeenCalledTimes(1);
  });

  it("says in its chat that a turn it cut off was cut off, once, and never runs it again", async () => {
    const thread = await insertThread({ turnStartedAt: new Date() });
    const messageId = randomUUID();
    await db.insert(messages).values({
      id: messageId,
      threadId: thread.id,
      role: "user",
      parts: [{ type: "text", text: "How is bitcoin doing?" }],
    });
    await turnKind.enqueue(db, { threadId: thread.id, messageId }, { key: messageId });
    // A turn marks its thread first thing.
    const release = await hold(
      (tx) => tx`select id from threads where id = ${thread.id} for update`,
    );
    await startChild();
    await until(async () => (await jobOf("turn")).startedAt !== null && (await waiting()) > 0);
    await killChild();
    await release();

    await restart([turnJob]);
    await until(async () => (await jobOf("turn")).outcome === "interrupted");
    const [after] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(after!.turnStartedAt).toBeNull();
    const said = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(said.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(said[1]!.parts)).toContain("I was cut off partway through this.");
    expect(heard).toContainEqual({
      topic: "thread",
      threadId: thread.id,
      event: { kind: "turn-end", turnId: messageId, failed: true },
    });
    await sleep(200);
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("runs a move allowed just before Auni died, once it starts again", async () => {
    const action = await insertAction({
      status: "awaiting_permission",
      input: { usd: "10" },
    });
    // The tap commits the move and its job together; nothing ran it before the process died.
    await decideActions({ actionId: action.id }, "allow");
    await restart([actionJob]);
    await until(async () => (await actionRow(action.id)).status === "done");
    expect(executions).toBe(1);
  });

  it("keeps a move cut off after it sent running for reconcile, and has the wallet resend", async () => {
    const action = await insertAction({
      startedAt: new Date(),
      txs: [{ chain: "base", hash: "0xsigned", walletTxId: randomUUID() }],
    });
    await db.insert(jobs).values({
      kind: "action",
      data: { actionId: action.id, lane: action.id, holding: `holding:${action.id}` },
      startedAt: sql`now()`,
      attempts: 1,
    });
    const resend = vi.spyOn(theWallet(), "resend");
    try {
      await restart([actionJob]);
      expect(resend).toHaveBeenCalledTimes(1);
    } finally {
      resend.mockRestore();
    }
    expect(await actionRow(action.id)).toMatchObject({
      status: "running",
      error: expect.stringContaining("stopped before finishing"),
    });
    expect(executions).toBe(0);
    expect(await jobOf("action")).toMatchObject({ outcome: "interrupted" });
  });
});

describe("a runner frozen, as a sleeping machine is", { timeout: 120_000 }, () => {
  it("ends the turn it ran, then runs what came due and a missed cron once", async () => {
    await db.insert(jobs).values({ kind: "hang", data: {} });
    const { process: frozen, lines } = await startChild("sleep", {
      AUNI_TEST_SLEEP_GAP_MS: "3000",
    });
    await until(() => lines.includes("hang started") && lines.includes("tick ran"));
    // Due while it's frozen, as the cron's next run is.
    await db.insert(jobs).values({ kind: "due", data: {}, runAt: new Date(Date.now() + 3_000) });
    frozen.kill("SIGSTOP");
    await sleep(5_000);
    const before = lines.length;
    frozen.kill("SIGCONT");
    const woke = () => lines.slice(before);
    await until(() => ["hang ended", "due ran", "tick ran"].every((line) => woke().includes(line)));
    // The cron's slots missed while frozen come to one run; its next is two seconds on.
    await sleep(500);
    expect(woke().filter((line) => line === "tick ran")).toHaveLength(1);
    expect(lines.filter((line) => line === "due ran")).toHaveLength(1);
    expect(await jobOf("hang")).toMatchObject({ outcome: "done" });
  });
});
