import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { takeHome } from "./home.ts";

// A demo's home sits at a name anyone can guess under the shared temporary folder, and what an
// earlier demo left there (a postmaster.pid naming a process that may since be any other) is
// cleared as it starts. Clearing it must touch nothing that isn't a demo's own.

const scratch = mkdtempSync(join(tmpdir(), "auni-demo-home-"));
const running: ChildProcess[] = [];

/** A process that runs until stopped, shown by `ps` as `argv0` and `args`. */
function aProcess(argv0: string, ...args: string[]): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], {
    argv0,
    stdio: "ignore",
  });
  running.push(child);
  return child;
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => (alive(child) ? child.once("exit", () => resolve()) : resolve()));

/** A home an earlier demo left, whose postmaster.pid names `pid`. */
function leftHome(name: string, pid: number): string {
  const home = join(scratch, name);
  mkdirSync(join(home, "postgres"), { recursive: true });
  writeFileSync(join(home, "postgres/postmaster.pid"), `${pid}\n${join(home, "postgres")}\n`);
  return home;
}

afterAll(() => {
  for (const child of running) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

describe("a demo's home", () => {
  it("stops the Postgres an earlier demo left running there, and starts empty", async () => {
    const home = leftHome("left", 0);
    const server = aProcess("/opt/pg/bin/postgres", "-D", join(home, "postgres"), "-p", "5432");
    writeFileSync(join(home, "postgres/postmaster.pid"), `${server.pid}\n`);
    takeHome(home);
    await exited(server);
    expect(server.signalCode).toBe("SIGQUIT");
    expect(readdirSync(home)).toEqual(["demo.pid"]);
  });

  it("leaves alone a process the pid file names that is not that Postgres", async () => {
    const theirs = aProcess("python3", "their-script.py");
    const otherServer = aProcess(
      "/opt/pg/bin/postgres",
      "-D",
      "/var/lib/their-postgres",
      "-p",
      "1",
    );
    takeHome(leftHome("reused", theirs.pid!));
    takeHome(leftHome("another", otherServer.pid!));
    await new Promise((settle) => setTimeout(settle, 200));
    expect(alive(theirs)).toBe(true);
    expect(alive(otherServer)).toBe(true);
  });

  it("refuses a home that is a link, and reads nothing through it", async () => {
    const real = leftHome("someones-auni", 0);
    const server = aProcess("/opt/pg/bin/postgres", "-D", join(real, "postgres"), "-p", "5432");
    writeFileSync(join(real, "postgres/postmaster.pid"), `${server.pid}\n`);
    const link = join(scratch, "linked");
    symlinkSync(real, link);
    expect(() => takeHome(link)).toThrow(/not a folder an earlier demo left/u);
    await new Promise((settle) => setTimeout(settle, 200));
    expect(alive(server)).toBe(true);
    expect(existsSync(join(real, "postgres/postmaster.pid"))).toBe(true);
  });
});
