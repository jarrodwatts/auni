import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A demo started `--at` a moment long past, as `pnpm demo:shots` starts it. Whatever day and
// hour this test runs, everything it shows is laid on that moment and stays there: that is what
// lets two sets of pictures be compared.

const AUNI = fileURLToPath(new URL("../../bin/auni.mjs", import.meta.url));
const AT = "2026-11-11T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60_000;
const scratch = mkdtempSync(join(tmpdir(), "auni-demo-clock-test-"));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("auni demo --at a moment", () => {
  let demo: ChildProcessByStdio<null, Readable, Readable>;
  let said = "";
  let ask: <T>(path: string) => Promise<T>;

  beforeAll(async () => {
    const port = await freePort();
    demo = spawn(
      process.execPath,
      [AUNI, "demo", "--no-open", "--no-web", "--port", String(port), "--at", AT],
      {
        // A time zone far from UTC, so a date read in the wrong one would show.
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratch, TZ: "Asia/Tokyo" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    demo.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
    demo.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
    await vi.waitFor(
      () => {
        if (demo.exitCode !== null) throw new Error(`The demo exited:\n${said}`);
        if (!/Open http:\/\/localhost:\d+\/app\/new#pair=/u.test(said)) throw new Error(said);
      },
      { timeout: 120_000, interval: 200 },
    );
    const core = `http://127.0.0.1:${/API is listening on [\d.]+:(\d+)/u.exec(said)![1]}`;
    const origin = `http://localhost:${port}`;
    // A session is written with one clock and checked with the other (Date, then now()).
    const paired = await fetch(`${core}/owner/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code: /#pair=(\S+)/u.exec(said)![1] }),
    });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    ask = async <T>(path: string) => {
      const answer = await fetch(`${core}${path}`, { headers: { cookie, origin } });
      expect(answer.ok, `${path} answered ${answer.status}`).toBe(true);
      return (await answer.json()) as T;
    };
  }, 180_000);

  afterAll(async () => {
    if (demo.exitCode !== null) return;
    demo.kill("SIGTERM");
    await new Promise((exited) => demo.once("exit", exited));
  });

  it("makes the same owner, with every scene of their past played", () => {
    expect(said).not.toMatch(/which refused|has no scene for|waited a minute|no stand-in for/u);
    expect(said).toMatch(/owner is ready \([\d.]+ s\): \d+ cards done, 5 waiting, 2 failed, 1 held/u);
  });

  it("lays the past week on that moment, and reads it the same a while later", async () => {
    interface History {
      readonly points: readonly { readonly takenAt: string; readonly usdValue: string }[];
    }
    const week = await ask<History>("/portfolio/history?range=1W");
    const at = Date.parse(AT);
    // An hour a point, from a week before the moment up to it, and nothing after.
    expect(Date.parse(week.points[0]!.takenAt)).toBe(at - 7 * DAY_MS);
    expect(week.points.at(-1)!.takenAt).toBe(AT);
    await sleep(1_500);
    expect(await ask<History>("/portfolio/history?range=1W")).toEqual(week);
  });

  it("dates the owner's past from that moment, in the time zone it runs in", async () => {
    const { items } = await ask<{ items: { title: string; at: string }[] }>("/activity");
    const stop = items.find(({ title }) => title === "Closed your ETH short");
    // Yesterday's short was closed at 09:15 (seed.ts), which in Tokyo is 00:15 UTC.
    expect(stop?.at).toBe("2026-11-10T00:15:00.000Z");
  });
});
