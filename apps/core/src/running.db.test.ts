import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

import { env } from "./env.ts";
import { runningAuni, stopAuni } from "./running.ts";

// The running Auni is read from its job runner's lock, whichever process holds it: here a real
// runner in a process of its own (test/runner-child.ts), started with no terminal, as a coding
// agent starts `auni` in the background.

const CHILD = fileURLToPath(new URL("test/runner-child.ts", import.meta.url));
const CORE = fileURLToPath(new URL("..", import.meta.url));

let child: ChildProcess | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = once(child, "exit");
    child.kill("SIGKILL");
    await gone;
  }
  child = undefined;
});

/** A runner on this database in a process of its own, once it holds the lock. */
async function startRunner(scenario: string, extraEnv: Record<string, string> = {}) {
  const started = spawn(process.execPath, [CHILD, scenario], {
    cwd: CORE,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child = started;
  let said = "";
  started.stdout!.setEncoding("utf8");
  started.stdout!.on("data", (chunk: string) => (said += chunk));
  for (const until = Date.now() + 60_000; !said.includes("ready"); await sleep(100))
    if (Date.now() > until) throw new Error("the runner never started");
  return { pid: started.pid!, said: () => said };
}

describe("the running Auni", { timeout: 90_000 }, () => {
  it("is the process whose runner holds this database, as it runs, until auni stop stops it", async () => {
    expect(await runningAuni()).toBeNull();
    const { pid } = await startRunner("sleep");
    const running = await runningAuni();
    expect(running).toEqual({ as: "background", pid, here: true });
    expect(await stopAuni(running!, { withinMs: 30_000 })).toBe(true);
    // Gone, and nothing holds the runner.
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(await runningAuni()).toBeNull();
  });

  it("is the service's when its recipe says so", async () => {
    const { pid } = await startRunner("sleep", { AUNI_RUNS_AS: "service" });
    expect(await runningAuni()).toEqual({ as: "service", pid, here: true });
  });

  it("says it still runs when it outlasts the wait, having asked once", async () => {
    const { pid, said } = await startRunner("deaf");
    expect(await stopAuni({ as: "background", pid, here: true }, { withinMs: 1_500 })).toBe(false);
    expect(said().match(/still finishing/gu)).toHaveLength(1);
    expect(await runningAuni()).toEqual({ as: "background", pid, here: true });
  });

  it("is another computer's when the session holding the lock names another", async () => {
    const other = postgres(env.DATABASE_URL, {
      max: 1,
      connection: { application_name: `auni service 4242 not-${hostname()}`.slice(0, 63) },
    });
    try {
      await other`select pg_advisory_lock(hashtext('auni:runner'))`;
      expect(await runningAuni()).toEqual({ as: "service", pid: 4242, here: false });
    } finally {
      await other.end();
    }
  });
});
