import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Postgres } from "./db/embedded.ts";
import { migrateDatabase } from "./db/migrations.ts";
import { startRunnerWhenFree } from "./jobs/runner.ts";
import { openBrowser } from "./open-browser.ts";
import { listen } from "./server.ts";
import { start } from "./start.ts";
import { startWebApp } from "./web-app.ts";

vi.mock("./agent/brain.ts", () => ({
  brainSeen: vi.fn(async () => ({ name: "Claude Code", line: "Claude ready." })),
  onBrainReady: vi.fn(() => () => {}),
  proveLogins: vi.fn(),
  terminalBrainLine: vi.fn(() => ""),
}));
vi.mock("./auth/owner.ts", () => ({
  lastPaired: vi.fn(async () => null),
  mintPairingCode: vi.fn(async () => "code"),
  pairingLink: vi.fn(() => "http://127.0.0.1:3000/app#pair=code"),
  theOwner: vi.fn(async () => ({ welcomedAt: null })),
}));
vi.mock("./db/client.ts", () => ({
  closeDatabaseConnection: vi.fn(async () => {}),
}));
vi.mock("./db/migrations.ts", () => ({
  migrateDatabase: vi.fn(async () => {}),
}));
vi.mock("./jobs/index.ts", () => ({ jobs: [] }));
vi.mock("./jobs/runner.ts", () => ({
  AlreadyRunning: class AlreadyRunning extends Error {},
  StillStopping: class StillStopping extends Error {},
  startRunner: vi.fn(),
  startRunnerWhenFree: vi.fn(),
  takeRunnerLock: vi.fn(),
}));
vi.mock("./handover/hand-over.ts", () => ({
  lendToHandover: vi.fn(),
  packHere: vi.fn(),
}));
vi.mock("./handover/marks.ts", () => ({
  takingOver: vi.fn(() => false),
  handedOver: vi.fn(() => null),
}));
vi.mock("./money/waiting.ts", () => ({
  takeBackStale: vi.fn(async () => {}),
}));
vi.mock("./open-browser.ts", () => ({
  canOpenBrowser: vi.fn(() => true),
  noteBrowserTry: vi.fn(),
  openBrowser: vi.fn(async () => {}),
}));
vi.mock("./running.ts", () => ({
  runningAuni: vi.fn(async () => null),
  runsAs: vi.fn(() => "terminal"),
  where: vi.fn(() => "in a terminal"),
}));
vi.mock("./server.ts", () => ({
  listen: vi.fn(),
}));
vi.mock("./web-app.ts", () => ({
  startWebApp: vi.fn(),
}));

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let exitedWith: Promise<number>;
let exitCodes: number[];
let errors: string[];
let logs: string[];
let database: Postgres;
let release: ReturnType<typeof vi.fn<() => Promise<void>>>;
let runnerStop: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
  vi.clearAllMocks();
  exitCodes = [];
  errors = [];
  logs = [];
  const exit = deferred<number>();
  exitedWith = exit.promise;
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    const value = code ?? 0;
    exitCodes.push(value);
    exit.resolve(value);
    return undefined as never;
  }) as typeof process.exit);
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  });

  release = vi.fn(async () => {});
  database = {
    url: "postgres://test",
    stopped: new Promise(() => {}),
    stopping: vi.fn(async () => {}),
    release,
    hold: vi.fn(async () => {}),
  };
  runnerStop = vi.fn(async () => {});
  vi.mocked(startRunnerWhenFree).mockResolvedValue({ stop: runnerStop });
  vi.mocked(listen).mockResolvedValue([
    { close: vi.fn(), closeAllConnections: vi.fn() } as unknown as Server,
  ]);
  vi.mocked(startWebApp).mockResolvedValue({
    kill: vi.fn(),
    once: vi.fn(),
  } as unknown as ChildProcess);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("start() cancelled by a signal", () => {
  it("exits quietly with 130 when Ctrl-C interrupts database migration", async () => {
    const migrating = deferred();
    vi.mocked(migrateDatabase).mockImplementationOnce(() => migrating.promise);

    const running = start(database, { web: false, open: false, jobs: true });
    process.emit("SIGINT", "SIGINT");
    // Stopping Postgres cuts off the migration query, as pg_ctl stop -m fast does.
    migrating.reject(new Error("terminating connection due to administrator command"));

    await running;
    expect(await exitedWith).toBe(130);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).not.toContain("Moves in progress");
  });

  it("waits for an in-flight migration to settle before releasing Postgres and skips later steps", async () => {
    const migrating = deferred();
    vi.mocked(migrateDatabase).mockImplementationOnce(() => migrating.promise);

    const running = start(database, { web: false, open: false, jobs: true });
    process.emit("SIGINT", "SIGINT");
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    migrating.resolve();
    await running;
    expect(await exitedWith).toBe(130);
    expect(startRunnerWhenFree).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("aborts onceUp and exits quietly with 130 when Ctrl-C arrives mid-seed", async () => {
    let sawAbort = false;
    const running = start(database, {
      web: false,
      open: false,
      jobs: true,
      onceUp: (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("write CONNECTION_ENDED"));
          });
          process.emit("SIGINT", "SIGINT");
        }),
    });

    await running;
    expect(await exitedWith).toBe(130);
    expect(sawAbort).toBe(true);
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).not.toContain("Moves in progress");
  });

  it("aborts startWebApp and exits quietly with 130 when Ctrl-C arrives while web starts", async () => {
    let sawAbort = false;
    vi.mocked(startWebApp).mockImplementationOnce(
      ({ signal } = {}) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("The web app exited (SIGINT)."));
          });
          process.emit("SIGINT", "SIGINT");
        }),
    );

    const running = start(database, { web: true, open: false, jobs: true });
    await running;
    expect(await exitedWith).toBe(130);
    expect(sawAbort).toBe(true);
    expect(errors).toEqual([]);
  });

  it("exits quietly with 130 when Ctrl-C arrives while opening the browser", async () => {
    const opening = deferred();
    vi.mocked(openBrowser).mockImplementationOnce(() => {
      process.emit("SIGINT", "SIGINT");
      return opening.promise;
    });

    const running = start(database, { web: true, open: true, jobs: true });
    opening.reject(new Error("CONNECTION_ENDED"));
    await running;
    expect(await exitedWith).toBe(130);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).not.toContain("Keep this terminal open");
  });

  it("exits quietly with 0 when SIGTERM arrives during startup", async () => {
    const migrating = deferred();
    vi.mocked(migrateDatabase).mockImplementationOnce(() => migrating.promise);

    const running = start(database, { web: false, open: false, jobs: true });
    process.emit("SIGTERM", "SIGTERM");
    migrating.reject(new Error("terminating connection due to administrator command"));

    await running;
    expect(await exitedWith).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("still reports a real startup failure and exits with 1", async () => {
    vi.mocked(migrateDatabase).mockRejectedValueOnce(new Error("relation missing"));

    await start(database, { web: false, open: false, jobs: true });
    expect(await exitedWith).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).toContain("Auni couldn't start.");
    expect(errors.join("\n")).toContain("relation missing");
  });

  it("prints the stopping notice when Ctrl-C arrives after startup finishes", async () => {
    await start(database, { web: false, open: false, jobs: true });
    process.emit("SIGINT", "SIGINT");
    expect(await exitedWith).toBe(130);
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Stopping Auni. Moves in progress will finish first");
    expect(errors).toEqual([]);
  });
});
