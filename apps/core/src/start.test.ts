import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Postgres } from "./db/embedded.ts";
import { closeDatabaseConnection } from "./db/client.ts";
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
let serverClose: ReturnType<typeof vi.fn<() => void>>;
let webKill: ReturnType<typeof vi.fn<() => void>>;

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
  serverClose = vi.fn();
  webKill = vi.fn();
  vi.mocked(startRunnerWhenFree).mockResolvedValue({ stop: runnerStop });
  vi.mocked(listen).mockResolvedValue([
    { close: serverClose, closeAllConnections: vi.fn() } as unknown as Server,
  ]);
  vi.mocked(startWebApp).mockResolvedValue({
    kill: webKill,
    once: vi.fn(),
  } as unknown as ChildProcess);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("start() cancelled by a signal", () => {
  it("exits quietly with 130 when Ctrl-C interrupts database migration", async () => {
    let sawAbort = false;
    vi.mocked(migrateDatabase).mockImplementationOnce(
      (_url, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("CONNECTION_DESTROYED"));
          });
          process.emit("SIGINT", "SIGINT");
        }),
    );

    const running = start(database, { web: false, open: false, jobs: true });

    await running;
    expect(await exitedWith).toBe(130);
    expect(sawAbort).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).not.toContain("Moves in progress");
  });

  it("waits for an in-flight migration to settle before releasing Postgres and skips later steps", async () => {
    const migrating = deferred();
    const migrateStarted = deferred();
    vi.mocked(migrateDatabase).mockImplementationOnce(() => {
      migrateStarted.resolve();
      return migrating.promise;
    });

    const running = start(database, { web: false, open: false, jobs: true });
    await migrateStarted.promise;
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
    expect(logs.join("\n")).toContain("Stopping Auni. Moves in progress will finish first");
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

  it("drains the runner and closes listeners at once while startup unwinds, keeping Postgres up until both finish", async () => {
    const building = deferred<ChildProcess>();
    const draining = deferred();
    const buildStarted = deferred();
    runnerStop.mockImplementationOnce(() => draining.promise);
    vi.mocked(startWebApp).mockImplementationOnce(() => {
      buildStarted.resolve();
      return building.promise;
    });

    const running = start(database, { web: true, open: false, jobs: true });
    await buildStarted.promise;
    process.emit("SIGINT", "SIGINT");
    await Promise.resolve();

    // Listeners close and the runner begins draining immediately, before startup finishes unwinding.
    expect(serverClose).toHaveBeenCalled();
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Stopping Auni. Moves in progress will finish first");
    expect(closeDatabaseConnection).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    // Startup settles while a move is still draining: Postgres stays up.
    building.reject(new Error("The web app exited (SIGINT)."));
    await Promise.resolve();
    await Promise.resolve();
    expect(closeDatabaseConnection).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    // Once the move finishes draining, Postgres closes and Auni exits quietly.
    draining.resolve();
    await running;
    expect(await exitedWith).toBe(130);
    expect(closeDatabaseConnection).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("stops a runner that startup finishes creating just as a stop begins", async () => {
    const starting = deferred<{ stop: () => Promise<void> }>();
    const waitStarted = deferred();
    vi.mocked(startRunnerWhenFree).mockImplementationOnce(() => {
      waitStarted.resolve();
      return starting.promise;
    });

    const running = start(database, { web: false, open: false, jobs: true });
    await waitStarted.promise;
    process.emit("SIGINT", "SIGINT");
    await Promise.resolve();
    expect(runnerStop).not.toHaveBeenCalled();

    starting.resolve({ stop: runnerStop });
    await running;
    expect(await exitedWith).toBe(130);
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(closeDatabaseConnection).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it("stops at once without waiting when a signal arrives while opening the browser", async () => {
    // Settles only when the stop cuts it off, as the real opener does (open-browser.test.ts).
    vi.mocked(openBrowser).mockImplementationOnce(
      (_url, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
          process.emit("SIGTERM", "SIGTERM");
        }),
    );

    const running = start(database, { web: true, open: true, jobs: true });
    await running;
    expect(await exitedWith).toBe(0);
    expect(serverClose).toHaveBeenCalled();
    expect(webKill).toHaveBeenCalledTimes(1);
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Stopping Auni. Moves in progress will finish first");
    expect(logs.join("\n")).not.toContain("Keep this terminal open");
  });

  it("exits quietly with 0 when SIGTERM arrives during startup", async () => {
    const migrating = deferred();
    const migrateStarted = deferred();
    vi.mocked(migrateDatabase).mockImplementationOnce(() => {
      migrateStarted.resolve();
      return migrating.promise;
    });

    const running = start(database, { web: false, open: false, jobs: true });
    await migrateStarted.promise;
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

  it("keeps Postgres up until a handover's in-flight runner drain finishes", async () => {
    const { lendToHandover } = await import("./handover/hand-over.ts");
    const draining = deferred();
    runnerStop.mockImplementation(() => draining.promise);

    await start(database, { web: false, open: false, jobs: true });
    const lent = vi.mocked(lendToHandover).mock.calls[0]?.[0];
    expect(lent).toBeTruthy();

    // Handover starts draining the runner (a move in flight), then SIGTERM arrives mid-drain.
    expect(lent!.signal?.aborted).toBe(false);
    const handoverStop = lent!.stopJobs();
    process.emit("SIGTERM", "SIGTERM");
    expect(lent!.signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    expect(closeDatabaseConnection).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Stopping Auni. Moves in progress will finish first");

    draining.resolve();
    await handoverStop;
    expect(await exitedWith).toBe(0);
    expect(closeDatabaseConnection).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });
});
