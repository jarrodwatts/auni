import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { openPostgres, postgresRunning, PostgresMismatch, stopPostgres } from "./embedded.ts";

// A real Postgres in a throwaway data folder: the one Auni runs when DATABASE_URL names none.

let dir: string;
beforeEach(() => {
  dir = tempDir("auni-embedded-");
  vi.stubEnv("AUNI_HOME", dir);
});
afterEach(async () => {
  // A test that failed midway may leave its server running.
  if (await postgresRunning()) await stopPostgres();
  vi.unstubAllEnvs();
});

async function query<T extends object>(url: string, text: string): Promise<T[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await sql.unsafe<T[]>(text);
  } finally {
    await sql.end();
  }
}

const reachable = (url: string) =>
  query(url, "select 1").then(
    () => true,
    () => false,
  );

/** The running server's process, as postmaster.pid names it: a new one is a server started again. */
const server = () =>
  Number(readFileSync(join(dir, "postgres/postmaster.pid"), "utf8").split("\n")[0]);

/** Whether `promise` is still waiting after `ms`. */
const pending = (promise: Promise<unknown>, ms = 1_500) =>
  Promise.race([promise.then(() => false), sleep(ms).then(() => true)]);

describe("openPostgres", () => {
  it("makes a database in the data folder, keeps what's written, and stops on release", async () => {
    const first = await openPostgres();
    expect(first.url).toMatch(/^postgres:\/\/auni:[0-9a-f]{64}@127\.0\.0\.1:\d+\/postgres$/u);
    expect(statSync(join(dir, "postgres-password")).mode & 0o777).toBe(0o600);
    await query(first.url, "create table kept (id int); insert into kept values (7)");
    await first.release();
    expect(await reachable(first.url)).toBe(false);

    const again = await openPostgres();
    expect(await query(again.url, "select id from kept")).toEqual([{ id: 7 }]);
    // On the port it had, so an address any process knows still reaches it.
    expect(again.url).toBe(first.url);
    await again.release();
  }, 60_000);

  it("says plainly what to do with files another major version of Postgres made", async () => {
    await (await openPostgres()).release();
    // As a data folder left by an Auni that carried an older Postgres.
    writeFileSync(join(dir, "postgres/PG_VERSION"), "15\n");
    const refused = await openPostgres().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PostgresMismatch);
    expect((refused as Error).message).toMatch(
      /made by Postgres 15, and this version of Auni carries Postgres \d+.*auni export.*auni import/su,
    );
    // Nothing was started on them, and nothing in them changed.
    expect(readFileSync(join(dir, "postgres/PG_VERSION"), "utf8")).toBe("15\n");
  }, 60_000);

  // An agent's `auni setup` runs right beside the `auni` it just began.
  it("lets two commands open it at once, and one's release leaves it to the other", async () => {
    const [auni, command] = await Promise.all([openPostgres(), openPostgres()]);
    expect(command.url).toBe(auni.url);
    await command.release();
    expect(await reachable(auni.url)).toBe(true);
    await auni.release();
    expect(await reachable(auni.url)).toBe(false);
  }, 60_000);

  it("never stops one the Auni running on it keeps when a command lets go", async () => {
    const auni = await openPostgres({ runsAuni: true });
    const command = await openPostgres();
    expect(command.url).toBe(auni.url);
    await command.release();
    expect(await reachable(auni.url)).toBe(true);
    await auni.release();
    expect(await reachable(auni.url)).toBe(false);
  }, 60_000);

  // As `auni stop` or `auni update` do: Postgres goes with the Auni that runs on it, as a
  // service's does with its cgroup.
  it("stops with the Auni that keeps it, and a command holding it then holds it again", async () => {
    const auni = await openPostgres({ runsAuni: true });
    const command = await openPostgres();
    await auni.release();
    expect(await reachable(auni.url)).toBe(false);
    await command.stopped;

    await command.hold();
    expect(await reachable(command.url)).toBe(true);
    await command.release();
    expect(await reachable(command.url)).toBe(false);
  }, 60_000);

  // The live failure: `auni up --always-on` had started Postgres in an agent's terminal, the
  // service started meanwhile ran on it, and it died with that terminal's session.
  it("never runs Auni on a command's Postgres: it waits for the command, then starts its own", async () => {
    const command = await openPostgres();
    const commands = server();
    const onWait = vi.fn();
    const opening = openPostgres({ runsAuni: true, onWait });
    expect(await pending(opening)).toBe(true);
    expect(onWait).toHaveBeenCalledOnce();

    await command.release();
    const auni = await opening;
    expect(server()).not.toBe(commands);
    expect(auni.url).toBe(command.url);
    expect(
      await query<{ name: string }>(
        auni.url,
        "select application_name as name from pg_stat_activity where application_name like 'auni postgres %'",
      ),
    ).toEqual([{ name: `auni postgres keeps ${process.pid}` }]);
    await auni.release();
  }, 60_000);

  it("starts one nobody holds again as its own: one a process that died left", async () => {
    const opens = fileURLToPath(new URL("./embedded.ts", import.meta.url));
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(opens)}).then((pg) => pg.openPostgres()); process.exit(0);`,
      ],
      { env: { ...process.env, AUNI_HOME: dir } },
    );
    const left = server();
    const auni = await openPostgres({ runsAuni: true });
    expect(server()).not.toBe(left);
    await auni.release();
    expect(await postgresRunning()).toBe(false);
  }, 60_000);

  // `auni` run twice: the second opens the browser on the first and goes.
  it("lets a second Auni use the one the first keeps, and leaves it to the first", async () => {
    const first = await openPostgres({ runsAuni: true });
    const kept = server();
    const second = await openPostgres({ runsAuni: true });
    expect(server()).toBe(kept);
    await second.release();
    expect(await reachable(first.url)).toBe(true);
    await first.release();
    expect(await reachable(first.url)).toBe(false);
  }, 60_000);

  // Ctrl-C, then `auni` again while the first still finishes a send.
  it("has an Auni started while another stops wait for it, then run its own", async () => {
    const first = await openPostgres({ runsAuni: true });
    const firsts = server();
    await first.stopping();
    const opening = openPostgres({ runsAuni: true });
    expect(await pending(opening)).toBe(true);
    await first.release();
    const second = await opening;
    expect(server()).not.toBe(firsts);
    await second.release();
  }, 60_000);

  // A Postgres killed under the service, then started again by a command meanwhile: the
  // service hears of it, and its release neither throws nor stops the command's.
  it("tells the Auni keeping it that it stopped, and lets go without stopping what runs there now", async () => {
    const auni = await openPostgres({ runsAuni: true });
    await stopPostgres();
    await auni.stopped;
    const command = await openPostgres();
    await auni.release();
    expect(await reachable(command.url)).toBe(true);
    await command.release();
  }, 60_000);

  it("lets go of one killed before its session heard, as a machine shutting down kills it", async () => {
    // Finding 95: Auni's stop crashed, unhandled, when pg_ctl couldn't stop the server killed
    // under it a moment before (its session's backend still alive, so nothing had told it).
    const auni = await openPostgres({ runsAuni: true });
    process.kill(server(), "SIGKILL");
    await expect(auni.release()).resolves.toBeUndefined();
    expect(await postgresRunning()).toBe(false);
  }, 60_000);
});
