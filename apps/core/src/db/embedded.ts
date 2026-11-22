import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import postgres, { type Sql } from "postgres";

import { dataDir, keptSecret } from "../data-dir.ts";
import { ownSession } from "./session.ts";

// The Postgres Auni runs for itself when DATABASE_URL names none: a real Postgres, from the
// embedded-postgres project's binaries for this machine, with its files in the data folder, on a
// port picked once and kept (postgres.port), so its address stays the same from start to start.
// pg_ctl starts it as a server of its own, in a session of its own, so a Ctrl-C meant for Auni
// never reaches it.
//
// It lives inside the Auni that runs (`auni`, in a terminal or as a service), which starts it and
// stops it as it stops: a service's Postgres is the service's own, in its cgroup, never that of
// a terminal that happened to start it, which takes it along when its session ends. Any other
// command (doctor, setup, pair...) uses the one running; with none, it starts one for itself,
// and the last one out stops it.
//
//   `auni` finds it stopped                        starts it, as its own
//   `auni` finds the one another Auni runs on      uses it: that one runs, so this one only
//                                                  opens the browser on it (start.ts)
//   `auni` finds a command's, or an Auni stopping  waits for them to let go, then starts its own
//   `auni` finds one nobody holds                  stops it and starts it again as its own: a
//                                                  process that died left it, where it ran
//
// So a command that starts Auni (its service, say) lets go of it first (boot.ts). Each process
// holds a session of its own on it from open to release (ownSession, so it isn't closed for its
// age an hour in), named for what it is to the server, "auni postgres keeps 4242": that is how
// the others know, and the name lasts exactly as long as that process holds it. Opening and
// letting go take a lock file in the data folder, so two never both start it, and one letting
// go never stops it under another opening.

const run = promisify(execFile);
const USER = "auni";

/** What a process holding it is to it: the Auni that keeps it, that Auni stopping, or any other. */
type Hold = "keeps" | "stopping" | "uses";
const holdName = (hold: Hold) => `auni postgres ${hold} ${process.pid}`;

export interface Postgres {
  /** A connection string, as DATABASE_URL would be. */
  readonly url: string;
  /**
   * Resolves if the server stops under this process while it holds it: killed, crashed, stopped
   * by hand, or by the Auni that kept it stopping.
   */
  readonly stopped: Promise<void>;
  /** Says the Auni keeping it is stopping, so an Auni started meanwhile waits for it to go. */
  stopping(): Promise<void>;
  /** Lets go: the Auni that keeps it stops it, and anyone else does as the last one out. */
  release(): Promise<void>;
  /** Holds it again after letting go, or after it stopped under this process, starting it if need be. */
  hold(): Promise<void>;
}

/**
 * Opens Auni's own Postgres, starting it if it's stopped. `runsAuni` is `auni` itself, which
 * keeps the server it runs on; `onWait` is said once while it waits for others to let go.
 */
export async function openPostgres({
  runsAuni = false,
  onWait,
}: { readonly runsAuni?: boolean; readonly onWait?: () => void } = {}): Promise<Postgres> {
  const dir = join(dataDir(), "postgres");
  const password = keptSecret("postgres-password");
  const bin = await binaries();
  const at = (port: number) => `postgres://${USER}:${password}@127.0.0.1:${port}/postgres`;
  const stop = () => run(bin.pg_ctl, ["stop", "-D", dir, "-m", "fast", "-w"]);
  let lost = () => {};
  const stopped = new Promise<void>((resolve) => (lost = resolve));

  interface Held {
    readonly url: string;
    readonly as: Hold;
    readonly session: Sql;
    gone: boolean;
  }
  const holding = async (url: string, as: Hold): Promise<Held> => {
    const held: Held = {
      url,
      as,
      gone: false,
      session: ownSession(url, () => {
        held.gone = true;
        lost();
      }),
    };
    await held.session`select set_config('application_name', ${holdName(as)}, false)`;
    return held;
  };

  /** A hold on the server, started if it's stopped; null while `auni` waits for others to let go. */
  const take = () =>
    locked(async (): Promise<Held | null> => {
      if (!existsSync(join(dir, "PG_VERSION"))) await initialise(bin.initdb, dir, password);
      else await sameMajor(bin.pg_ctl, dir);
      if (await postgresRunning()) {
        const url = at(portOf(dir));
        const others = await holdsOn(url);
        if (!runsAuni || others.includes("keeps")) return holding(url, "uses");
        if (others.length > 0) return null;
        // Nobody holds it, so a process that died left it, running where that one ran.
        await stop();
      }
      const port = await portToStart();
      await run(bin.pg_ctl, [
        "start",
        "-D",
        dir,
        "-w",
        "-l",
        postgresLog(),
        // TCP on this machine only, and no Unix socket, which a box that shows /tmp would expose.
        "-o",
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
      ]);
      return holding(at(port), runsAuni ? "keeps" : "uses");
    });
  const takeWhenFree = async (): Promise<Held> => {
    for (let waited = false; ; waited = true) {
      const held = await take();
      if (held) return held;
      if (!waited) onWait?.();
      await sleep(500);
    }
  };

  let held: Held | null = await takeWhenFree();
  const { url } = held;
  return {
    url,
    stopped,
    stopping: async () => {
      if (!held || held.gone) return;
      try {
        await held.session`select set_config('application_name', ${holdName("stopping")}, false)`;
      } catch {
        // A session that can't answer is closing, which tells a new Auni as much.
      }
    },
    release: () =>
      locked(async () => {
        const was = held;
        held = null;
        if (!was) return;
        await was.session.end();
        // Stopped under it: whatever runs there now is not the server it held.
        if (was.gone) return;
        if (was.as !== "uses" || (await holdsOn(url)).length === 0)
          // Killed meanwhile, before its session heard (a machine shutting down stops both), it
          // is stopped all the same.
          await stop().catch(async (error: unknown) => {
            if (await postgresRunning()) throw error;
          });
      }),
    hold: async () => {
      // Asked, since the server may have stopped a moment before its session's close is heard.
      const answers = (session: Sql) =>
        session`select 1`.then(
          () => true,
          () => false,
        );
      if (held && !held.gone && (await answers(held.session))) return;
      await held?.session.end({ timeout: 0 });
      held = await takeWhenFree();
      if (held.url !== url)
        throw new Error(
          "Auni's database was started again on another port meanwhile: run this command again.",
        );
    },
  };
}

/** What each other process holding the server at `url` is to it, by its session's name. */
async function holdsOn(url: string): Promise<Hold[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const holders = await sql<{ name: string }[]>`
    select application_name as name from pg_stat_activity
    where application_name like 'auni postgres %' and pid <> pg_backend_pid()`.finally(() =>
    sql.end(),
  );
  return holders.map(({ name }) => name.split(" ")[2] as Hold);
}

/** Where Postgres writes what it says, starting and stopping among it. */
export const postgresLog = (): string => join(dataDir(), "postgres.log");

/**
 * This Auni's database files were made by another major version of Postgres than the one it
 * carries, which can't open them. Its message says the way across: an export from the version
 * that made them, loaded by this one.
 */
export class PostgresMismatch extends Error {
  constructor(dir: string, made: string, carried: string) {
    super(
      `Auni's database in ${dir} was made by Postgres ${made}, and this version of Auni carries ` +
        `Postgres ${carried}, which can't open it. Nothing was changed. To bring your data across: ` +
        "go back to the version of Auni that made it (auni update --version <that version>) and " +
        `run auni export; then, on this version, move ${dir} aside and run auni import --from ` +
        "<that file>. The copies auni update keeps (app/backups) each hold such an export too.",
    );
  }
}

/** Throws PostgresMismatch unless the files in `dir` are of the major version `pg_ctl` runs. */
async function sameMajor(pg_ctl: string, dir: string): Promise<void> {
  // "18" in the data folder; "pg_ctl (PostgreSQL) 18.6" from the binary.
  const made = readFileSync(join(dir, "PG_VERSION"), "utf8").trim();
  const { stdout } = await run(pg_ctl, ["--version"]);
  const carried = /(\d+)(?:\.\d+)*\s*$/u.exec(stdout.trim())?.[1];
  if (carried && carried !== made) throw new PostgresMismatch(dir, made, carried);
}

/**
 * Whether Auni's own Postgres server is running, whoever started it: pg_ctl status exits 0 when
 * postmaster.pid names a live server.
 */
export async function postgresRunning(): Promise<boolean> {
  const { pg_ctl } = await binaries();
  return run(pg_ctl, ["status", "-D", join(dataDir(), "postgres")]).then(
    () => true,
    () => false,
  );
}

/** Stops Auni's own Postgres server, whoever started it: for one an Auni that crashed left. */
export async function stopPostgres(): Promise<void> {
  const { pg_ctl } = await binaries();
  await run(pg_ctl, ["stop", "-D", join(dataDir(), "postgres"), "-m", "fast", "-w"]);
}

/**
 * Runs `fn` holding the data folder's Postgres lock: a file only one process can make, naming
 * its pid, so a lock left by a process that died is taken over.
 */
async function locked<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const lock = join(dataDir(), "postgres.lock");
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!alive(Number(readFileSync(lock, "utf8").trim() || 0))) rmSync(lock, { force: true });
    else await sleep(100);
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Whether a process is running; a pid we may not signal is one that runs. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Binaries {
  readonly initdb: string;
  readonly pg_ctl: string;
}

async function binaries(): Promise<Binaries> {
  const name = `@embedded-postgres/${platform()}-${arch()}`;
  try {
    // The package is named by this machine's platform, so its path is computed; it is no app.
    // eslint-disable-next-line auni/import-paths
    return (await import(name)) as Binaries;
  } catch {
    throw new Error(
      `Auni has no Postgres of its own for ${platform()}-${arch()} (${name}). ` +
        "Set DATABASE_URL to a Postgres of yours.",
    );
  }
}

/** Makes the database files, in a folder of their own until done, so a half-made one is never used. */
async function initialise(initdb: string, dir: string, password: string): Promise<void> {
  const making = `${dir}.new`;
  const passwordFile = join(dataDir(), "postgres-password.initdb");
  rmSync(making, { recursive: true, force: true });
  mkdirSync(making, { mode: 0o700 });
  writeFileSync(passwordFile, password, { mode: 0o600 });
  try {
    await run(initdb, [
      "-D",
      making,
      "-U",
      USER,
      `--pwfile=${passwordFile}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      // Unicode-aware upper() and lower() that sort the same on every machine.
      "--locale-provider=builtin",
      "--builtin-locale=C.UTF-8",
      "--locale=C",
    ]);
  } finally {
    rmSync(passwordFile, { force: true });
  }
  renameSync(making, dir);
}

/** The port a running server listens on: postmaster.pid's fourth line. */
function portOf(dir: string): number {
  return Number(readFileSync(join(dir, "postmaster.pid"), "utf8").split("\n")[3]);
}

/**
 * The port to start it on: the one it was started on before while that's free, so every process
 * that knows its address still reaches it, else one free now, kept for next time.
 */
async function portToStart(): Promise<number> {
  const file = join(dataDir(), "postgres.port");
  const kept = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  const port = (kept > 0 && (await listenable(kept))) || (await listenable(0));
  if (!port) throw new Error("Auni found no free port on 127.0.0.1 for its database.");
  if (port !== kept) writeFileSync(file, String(port), { mode: 0o600 });
  return port;
}

/** `port` (0: any) if something may listen on it on 127.0.0.1 now, as the port it got; else null. */
function listenable(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : null));
    });
  });
}
