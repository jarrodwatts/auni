import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import postgres from "postgres";

import { auniLog, dataDir } from "./data-dir.ts";
import { env } from "./env.ts";
import { selfCommand } from "./release/layout.ts";
import { serviceInstalled, stopService } from "./service.ts";

// Which Auni runs on this database, and how, so any `auni` command can say what is running and
// stop it, whatever started it. The fact is the job runner's lock (jobs/runner.ts): an Auni runs
// while its runner holds it, and the Postgres session holding it is named for the process that
// holds it, "auni background 4242 laptop". No pid file: the name lasts exactly as long as the
// lock does, and goes with it when that process dies.
//
//   terminal     `auni` with a terminal attached: Ctrl-C there stops it, as `auni stop` does
//   background   `auni` with none: a coding agent's, or the one `auni update` starts again
//   service      `auni service install`'s, whose recipe says so (AUNI_RUNS_AS, service.ts)

export type RunsAs = "terminal" | "background" | "service";

export interface RunningAuni {
  readonly as: RunsAs;
  readonly pid: number;
  /** It runs on this computer, so this one can stop it: not another sharing DATABASE_URL. */
  readonly here: boolean;
}

/** How this process runs: the service's recipe says so, else whether it has a terminal. */
export function runsAs(): RunsAs {
  if (process.env.AUNI_RUNS_AS === "service") return "service";
  return process.stdin.isTTY || process.stdout.isTTY ? "terminal" : "background";
}

/** This computer's name as Postgres keeps a session's: printable ASCII, the rest as "?". */
const machine = () => hostname().replace(/[^\x20-\x7e]/gu, "?");
/** Postgres keeps the first 63 bytes of a session's name. */
const named = (as: RunsAs, pid: number) => `auni ${as} ${pid} ${machine()}`.slice(0, 63);

/** The name of the session that holds the runner's lock, for this process. */
export const holderName = (): string => named(runsAs(), process.pid);

const HOLDER = /^auni (terminal|background|service) (\d+) /u;

/**
 * The Auni whose runner holds this database's lock, or null when none runs: as when nothing
 * answers at its address, since Auni's own Postgres stops with the Auni that ran it.
 */
export async function runningAuni(): Promise<RunningAuni | null> {
  const own = postgres(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    // This database's alone, as one Postgres may hold several. An advisory lock on one bigint
    // keeps its high half in classid and its low half in objid.
    const [holder] = await own<{ name: string }[]>`
      select a.application_name as name from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted and l.objsubid = 1
        and l.database = (select oid from pg_database where datname = current_database())
        and ((l.classid::bigint << 32) | l.objid::bigint) = hashtext('auni:runner')::bigint`;
    if (!holder) return null;
    const [, as, pid] = HOLDER.exec(holder.name) ?? [];
    if (!as) return { as: "background", pid: 0, here: false };
    return {
      as: as as RunsAs,
      pid: Number(pid),
      here: holder.name === named(as as RunsAs, Number(pid)),
    };
  } catch (error) {
    // No server there, or one starting or stopping (57P03): none holds a lock on it.
    if (["ECONNREFUSED", "57P03"].includes((error as { code?: string }).code ?? "")) return null;
    throw error;
  } finally {
    await own.end();
  }
}

/**
 * Waits for an Auni just started here (its service, say) to run, its runner held, up to
 * `withinMs`: false if it doesn't. It first starts Postgres and brings the database up to date.
 */
export async function cameUp({
  withinMs = 90_000,
}: { readonly withinMs?: number } = {}): Promise<boolean> {
  for (const until = Date.now() + withinMs; Date.now() < until; await sleep(500))
    if (await runningAuni()) return true;
  return false;
}

/** Where it runs, as a sentence ends: "in a terminal", "in the background", "as a service". */
export function where({ as }: { readonly as: RunsAs }): string {
  return { terminal: "in a terminal", background: "in the background", service: "as a service" }[
    as
  ];
}

/** Stopping waits up to two minutes for a send in flight (start.ts), and a margin to let go. */
const STOP_MS = 150_000;

/**
 * Stops the Auni running here, as a Ctrl-C would, so running moves get their two minutes: the
 * service through its own stop, so it isn't started again, and any other with SIGTERM. Resolves
 * once that process has gone and nothing holds the runner, or false if something still does
 * after STOP_MS. Asking twice stops it no sooner (start.ts): only a second Ctrl-C does.
 */
export async function stopAuni(
  running: RunningAuni,
  { withinMs = STOP_MS }: { readonly withinMs?: number } = {},
): Promise<boolean> {
  if (running.as === "service" && serviceInstalled()) stopService();
  else signal(running.pid, "SIGTERM");
  for (const until = Date.now() + withinMs; ; await sleep(250)) {
    if (!alive(running.pid) && !(await runningAuni())) return true;
    if (Date.now() >= until) return false;
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    // Gone already, between reading the lock and now.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Starts Auni in the background, as this machine runs it (an install's launcher), with no
 * terminal and no browser opened, outliving the command that starts it. `shell` is the
 * environment as the owner's shell gave it, not this process's own after boot() filled it in.
 */
export function startInBackground(shell: NodeJS.ProcessEnv): void {
  const log = openSync(auniLog(), "a");
  const [command, ...args] = selfCommand();
  spawn(command!, [...args, "--no-open"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...shell, AUNI_HOME: dataDir() },
  }).unref();
  closeSync(log);
}
