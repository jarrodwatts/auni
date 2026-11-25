import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { dataDir } from "../data-dir.ts";
import { where, type RunningAuni } from "../running.ts";
import {
  appDir,
  backupsDir,
  BUILT,
  currentTag,
  launcher,
  listVersions,
  switchCurrent,
  versionDir,
} from "./layout.ts";
import { checkRelease, ReleaseRefused, sourceTag } from "./check.ts";
import type { Release } from "./manifest.ts";
import { byRelease, isReleaseTag } from "./tags.ts";

// `auni update [--version vX] [--yes]`: the next version, built beside this one, takes over only
// once it has come up. The version running now does all of it, so the code that checks the
// release is the code that was trusted, and the code that rolls back is the code that was working:
//
//   check vX (this version's install.sh: signed by a release key it lists; the newest offered is
//     never older than vY, though an older one the owner names is theirs to go back to)
//     -> say what vX is, what changed, and that the running Auni stops -> the owner says yes
//     -> build vX beside vY (install.sh) -> stop Auni -> copy its database -> current = vX
//     -> start vX, its jobs off: answers within a minute?
//          yes -> stop it, keep it, drop the oldest copies
//          no  -> current = vY, the copy back
//     -> start Auni again as it ran (the service, or in the background), with its jobs
//
// The probe runs no job (`--no-jobs`, start.ts): a roll back puts the copy back over whatever the
// new version wrote, so a move it sent would be forgotten, and sent again by the old one.

/** What update needs from this machine; a test stands in its own. */
export interface UpdateHost {
  /** The environment as the owner's shell gave it, for what update starts. */
  readonly env: NodeJS.ProcessEnv;
  /** The Auni running on this database, and how, or null when none does (running.ts). */
  readonly running: () => Promise<RunningAuni | null>;
  /** Stops it however it runs, its running moves first: false if it still runs after that. */
  readonly stop: (running: RunningAuni) => Promise<boolean>;
  /** Starts Auni again, as the service or in the background, and doesn't wait for it. */
  readonly start: (as: "service" | "background") => void;
  /** Auni's own Postgres (db/embedded.ts); null when DATABASE_URL names the owner's own. */
  readonly postgres: {
    /** Lets go of this process's hold on it, which stops it once nothing else holds it. */
    readonly release: () => Promise<void>;
    /** Holds it again, starting it if it stopped: as it does with the Auni that ran it. */
    readonly hold: () => Promise<void>;
    readonly running: () => Promise<boolean>;
    readonly stop: () => Promise<void>;
  } | null;
  /** Writes everything the database holds to `file` (db/export.ts), while it is still up. */
  readonly export: (file: string) => Promise<void>;
  /** Where the owner opens the web app (WEB_ORIGIN): a version that came up answers /core/health there. */
  readonly origin: string;
  readonly healthyWithinMs: number;
  /** The owner's yes or no to `question`, once update has said what the release is. */
  readonly confirm: (question: string) => Promise<boolean>;
}

/** What update refuses to do, in the words to say. */
export class UpdateRefused extends Error {}

/** Stopping waits up to two minutes for a send in flight (start.ts). */
const STOP_MS = 150_000;
const STOP_TIMEOUT = "Auni didn't stop within 2.5 minutes, so nothing changed.";
const ELSEWHERE =
  "Auni is running on this database from another computer. Stop it there, then run auni update.";

const say = (line: string) => console.log(line);

/** Updates to `version`, or the newest release. Throws UpdateRefused where it changed nothing. */
export async function update({
  version,
  host,
}: {
  readonly version?: string;
  readonly host: UpdateHost;
}): Promise<"updated" | "same" | "declined" | "rolled-back"> {
  return withLock(async () => {
    const from = currentTag();
    if (!from) throw new UpdateRefused("Auni isn't installed here yet. Run install.sh first.");
    if (version !== undefined && !isReleaseTag(version))
      throw new UpdateRefused(`"${version}" isn't a valid version (expected format like v0.1.0).`);
    const own = Boolean(host.env.AUNI_SOURCE);
    say(own ? "Checking the source you supplied." : "Checking for updates.");
    const release = own ? null : await check(from, version, host);
    // A source is the version --version names, or the one its package.json says, as install.sh reads it.
    const to = release?.version ?? version ?? (await tagOf(from, host));
    if (to === from) {
      say(
        own && !version
          ? `Auni is already on ${to}. Pass --version <vX.Y.Z> to build this source under a different version.`
          : `Auni is already on ${to}${version ? "" : " (latest)"}.`,
      );
      return "same";
    }
    const running = await host.running();
    if (running && !running.here) throw new UpdateRefused(ELSEWHERE);

    say(
      release
        ? described(release, from)
        : `Update ${from} -> ${to} from the source you supplied (unsigned).`,
    );
    // Said before asking, so the yes is to stopping it too.
    if (running) say(stopsAndStarts(running, to));
    if (!(await host.confirm(`Update from ${from} to ${to}?`))) {
      say("Nothing changed.");
      return "declined";
    }
    if (!existsSync(join(versionDir(to), BUILT))) await build(from, to, host);

    if (running) {
      say("Stopping Auni. Moves in progress will finish first.");
      if (!(await host.stop(running))) throw new UpdateRefused(STOP_TIMEOUT);
      // Its own Postgres stopped with it (db/embedded.ts): held again, for the export.
      await host.postgres?.hold();
    }
    // Whatever happens from here, Auni runs again as it ran, on whichever version is current.
    const again = () => startAgain(running, host);
    let backup: string | null;
    try {
      backup = await backUp(from, host);
    } catch (error) {
      await again();
      throw error;
    }

    switchCurrent(to);
    say(`Checking that ${to} starts.`);
    const { came, output } = await probe(host);
    if (came === "up") {
      keepOnly([from, to]);
      say(`\nUpdated to Auni ${to}.${running ? "" : "\nRun auni to start it."}`);
      await again();
      return "updated";
    }

    process.stdout.write(output);
    switchCurrent(from);
    const left = host.postgres && backup ? await restore(backup, host.postgres) : null;
    // What failed goes, but for what it left of the data: a version tried again is built again.
    keepOnly(listVersions().filter((tag) => tag !== to));
    const what =
      came === "stopped"
        ? `${to} exited during startup`
        : `${to} didn't start within ${Math.round(host.healthyWithinMs / 1_000)} seconds`;
    say(
      left
        ? `\n${what}, so Auni rolled back to ${from} with your data intact. Startup output is above.\n` +
            `Files left by ${to} are saved at ${left}; delete them once you no longer need them.`
        : `\n${what}, so Auni rolled back to ${from}. Your external database wasn't restored, and ${to} may have changed it. Startup output is above.\n` +
            `A pre-update backup is in ${backupsDir()} (restore into an empty database with auni import).`,
    );
    await again();
    return "rolled-back";
  });
}

/** The release to update to, as the installer `from` came with checks it. */
async function check(
  from: string,
  version: string | undefined,
  host: UpdateHost,
): Promise<Release> {
  return checkRelease({
    installer: join(versionDir(from), "install.sh"),
    env: { ...host.env, AUNI_HOME: dataDir() },
    ...(version ? { version } : {}),
  }).catch((error: unknown) => {
    throw error instanceof ReleaseRefused
      ? new UpdateRefused(`${error.message} Auni stays on ${from}.`)
      : error;
  });
}

/** What the owner reads before saying yes: which release, when it was made, and what changed. */
function described(release: Release, from: string): string {
  const day = new Date(release.made).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const notes = release.notes || "This release has no notes.";
  const action = byRelease(release.version, from) < 0 ? "Switch back" : "Update";
  return `${action} ${from} -> ${release.version} (${day}, signature verified)\n\n${notes}\n`;
}

/**
 * Builds `to` beside `from` with the installer `from` came with. Its steps are shown only when it
 * fails, as the probe's output is: the rest of the time update tells the story.
 */
async function build(from: string, to: string, host: UpdateHost): Promise<void> {
  say(`Building ${to} alongside ${from} (this takes a few minutes).`);
  const installer = spawn("sh", [join(versionDir(from), "install.sh")], {
    env: { ...host.env, AUNI_HOME: dataDir(), AUNI_VERSION: to },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(installer);
  // "close", not "exit": a process can exit before what it wrote has been read, which lost the
  // installer's reason for failing whenever the machine was busy.
  const [code] = (await once(installer, "close")) as [number | null];
  if (code === 0) return;
  process.stdout.write(output());
  throw new UpdateRefused(
    `\n${to} failed to build, so Auni stays on ${from}. See the build output above.`,
  );
}

/** Everything `child` writes, stdout and stderr in the order written. */
function collect(child: ChildProcess): () => string {
  const chunks: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString();
}

/** The tag of the source AUNI_SOURCE names, as the installer `from` came with reads it. */
async function tagOf(from: string, host: UpdateHost): Promise<string> {
  return sourceTag({
    installer: join(versionDir(from), "install.sh"),
    env: { ...host.env, AUNI_HOME: dataDir() },
  }).catch((error: unknown) => {
    throw error instanceof ReleaseRefused
      ? new UpdateRefused(`${error.message} Auni stays on ${from}.`)
      : error;
  });
}

/** What becomes of the running Auni, said before the owner says yes. */
function stopsAndStarts(running: RunningAuni, to: string): string {
  const again = running.as === "service" ? "as a service" : "in the background";
  return `Auni is running ${where(running)}. It will finish any moves in progress, stop, and restart ${again} once ${to} is verified.`;
}

/**
 * Starts Auni again as `running` ran, on whichever version is current: the service as the
 * service, and one in a terminal or the background in the background, as no terminal waits
 * for it now. Says once its web app answers, or that it didn't in time. With none running
 * before, none is started.
 */
async function startAgain(running: RunningAuni | null, host: UpdateHost): Promise<void> {
  if (!running) return;
  const as = running.as === "service" ? "service" : "background";
  // Let go of first, so the Auni started runs Postgres as its own (db/embedded.ts).
  await host.postgres?.release();
  host.start(as);
  const how = `${as === "service" ? "as a service" : "in the background"} ${running.as === "terminal" ? "now" : "again"}`;
  say(
    (await answers(host))
      ? `Auni is running ${how}.\nOpen ${host.origin}\nRun auni stop to stop it.`
      : `Auni started ${how}, but the web app didn't answer within ${Math.round(host.healthyWithinMs / 1_000)} seconds.\nRun auni doctor`,
  );
}

/**
 * An export of everything in the database, then a cold copy of Auni's own Postgres, taken while
 * it's stopped, as only a stopped one's files are whole. Null with the owner's own database,
 * whose files are theirs to back up: it has the export alone.
 */
async function backUp(from: string, host: UpdateHost): Promise<string | null> {
  const backup = join(backupsDir(), `${from}-${utc()}`);
  // First, while the database is up: a file any later version can load, whatever becomes of
  // the database's own files (db/export.ts).
  const exported = join(backup, "export.jsonl.gz");
  await host.export(exported).catch((error: unknown) => {
    throw new UpdateRefused(
      `Couldn't export your database before updating (${error instanceof Error ? error.message : String(error)}), so nothing changed.`,
    );
  });
  say(`Saved a database export to ${exported}`);
  if (!host.postgres) {
    say("Your external database stays untouched. Only the export was saved.");
    return null;
  }
  await host.postgres.release();
  if (await host.postgres.running()) {
    rmSync(backup, { recursive: true, force: true });
    throw new UpdateRefused(
      "Auni's database is still running, so it can't be copied safely. Nothing changed. " +
        "Wait for any other auni command to finish, then run auni update again.",
    );
  }
  cpSync(liveDatabase(), join(backup, "postgres"), {
    recursive: true,
    preserveTimestamps: true,
  });
  say("Saved a copy of Auni's database files.");
  return backup;
}

/**
 * Puts the copy back, keeping what the new version left beside it, and says where that is. The
 * copy moves back rather than being copied, since the database is that copy again.
 */
async function restore(
  backup: string,
  postgres: NonNullable<UpdateHost["postgres"]>,
): Promise<string> {
  if (await postgres.running()) await postgres.stop();
  const live = liveDatabase();
  const left = `${live}${FAILED}${utc()}`;
  // One left within the same second would go anyway, as only the newest is kept.
  rmSync(left, { recursive: true, force: true });
  renameSync(live, left);
  renameSync(join(backup, "postgres"), live);
  rmSync(backup, { recursive: true, force: true });
  return left;
}

const liveDatabase = () => join(dataDir(), "postgres");
/** Beside the live database, what a version that didn't come up left of it: postgres.failed-<utc>. */
const FAILED = ".failed-";

/**
 * Starts `current` as the service would, but with its jobs off, then stops it: whether it came up
 * (answered in time), stopped on its own first, or was still starting when its time ran out.
 */
async function probe(
  host: UpdateHost,
): Promise<{ came: "up" | "stopped" | "slow"; output: string }> {
  const child = spawn(launcher(), ["--no-open", "--no-jobs"], {
    env: { ...host.env, AUNI_HOME: dataDir() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collect(child);
  const came = (await answers(host, child)) ? "up" : alive(child) ? "slow" : "stopped";
  await stop(child);
  return { came, output: output() };
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** Whether the web app answers within healthyWithinMs, giving up early if `child` stops. */
async function answers(host: UpdateHost, child?: ChildProcess): Promise<boolean> {
  for (
    const until = Date.now() + host.healthyWithinMs;
    (!child || alive(child)) && Date.now() < until;
  ) {
    const ok = await fetch(`${host.origin}/core/health`, {
      signal: AbortSignal.timeout(2_000),
    }).then(
      (answer) => answer.ok,
      () => false,
    );
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

/** A Ctrl-C's stop, with its two minutes for a send in flight, then a kill. */
async function stop(child: ChildProcess): Promise<void> {
  if (!alive(child)) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
  await exited;
  clearTimeout(kill);
}

/**
 * What an install keeps after an update, whether it came up or not: these versions and the Node
 * they run on, the two newest copies of the database, and the newest that a failed version left.
 */
function keepOnly(versions: readonly string[]): void {
  for (const tag of listVersions())
    if (!versions.includes(tag)) rmSync(versionDir(tag), { recursive: true, force: true });
  const nodes = versions.map((tag) => basename(readlinkSync(join(versionDir(tag), ".node"))));
  for (const node of readdirSync(join(appDir(), "node")))
    if (!nodes.includes(node))
      rmSync(join(appDir(), "node", node), { recursive: true, force: true });
  // Both kinds of name end in the time they were made: <tag>-<utc>, postgres.failed-<utc>.
  const newestFirst = (names: string[]) =>
    names.sort((a, b) => b.slice(b.lastIndexOf("-")).localeCompare(a.slice(a.lastIndexOf("-"))));
  if (existsSync(backupsDir()))
    for (const old of newestFirst(readdirSync(backupsDir())).slice(2))
      rmSync(join(backupsDir(), old), { recursive: true, force: true });
  const failed = readdirSync(dataDir()).filter((name) =>
    name.startsWith(`${basename(liveDatabase())}${FAILED}`),
  );
  for (const old of newestFirst(failed).slice(1))
    rmSync(join(dataDir(), old), { recursive: true, force: true });
}

/** Now, as a name sorts: 20261108T212400Z. */
const utc = () => new Date().toISOString().replace(/[-:]|\.\d+/gu, "");

/** One update at a time: a lock file naming its pid, taken over from one that died. */
async function withLock<T>(work: () => Promise<T>): Promise<T> {
  const lock = join(appDir(), "update.lock");
  mkdirSync(appDir(), { recursive: true });
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number(readFileSync(lock, "utf8"));
    if (alivePid(holder)) throw new UpdateRefused("Another auni update is already running.");
    writeFileSync(lock, String(process.pid));
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
}

function alivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
