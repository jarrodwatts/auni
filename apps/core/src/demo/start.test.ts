import { afterEach, expect, it, vi } from "vitest";

import { openPostgres } from "../db/embedded.ts";
import { takeHome } from "./home.ts";
import { startDemo } from "./start.ts";

vi.mock("../data-dir.ts", () => ({
  auniLog: () => "unused",
  keptSecret: () => "demo-test",
}));
vi.mock("../db/embedded.ts", () => ({ openPostgres: vi.fn() }));
vi.mock("./home.ts", () => ({
  demoEnvironment: vi.fn(async () => ({ home: "unused", ports: [] })),
  takeHome: vi.fn(),
}));

const options = { port: 3939, web: false, open: false };
const interrupt = () => process.emit("SIGINT", "SIGINT");
const exitCode = process.exitCode;

afterEach(() => {
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("skips Postgres when Ctrl-C arrives before boot", async () => {
  vi.mocked(takeHome).mockImplementationOnce(() => {
    interrupt();
  });
  await startDemo(options);
  expect(openPostgres).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(130);
});

it("exits quietly when Ctrl-C interrupts initdb", async () => {
  vi.stubEnv("TURN_TOKEN_SECRET", undefined);
  vi.mocked(openPostgres).mockImplementationOnce(async () => {
    interrupt();
    throw new Error("initdb was interrupted");
  });
  await expect(startDemo(options)).resolves.toBeUndefined();
  expect(process.exitCode).toBe(130);
});

it("releases Postgres when Ctrl-C arrives while it is starting", async () => {
  vi.stubEnv("TURN_TOKEN_SECRET", undefined);
  const release = vi.fn(async () => {});
  vi.mocked(openPostgres).mockImplementationOnce(async () => {
    interrupt();
    return {
      url: "unused",
      release,
      stopped: new Promise(() => {}),
      stopping: vi.fn(),
      hold: vi.fn(),
    };
  });
  await startDemo(options);
  expect(release).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(130);
});
