import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

import { brainSeen, onBrainReady, proveLogins } from "./agent/brain.ts";
import { lastPaired, mintPairingCode, pairingLink, theOwner } from "./auth/owner.ts";
import { closeDatabaseConnection } from "./db/client.ts";
import { postgresLog, type Postgres } from "./db/embedded.ts";
import { migrateDatabase } from "./db/migrations.ts";
import { env } from "./env.ts";
import { jobs } from "./jobs/index.ts";
import {
  AlreadyRunning,
  StillStopping,
  startRunner,
  startRunnerWhenFree,
  takeRunnerLock,
  type Runner,
} from "./jobs/runner.ts";
import { lendToHandover, packHere } from "./handover/hand-over.ts";
import { takingOver, handedOver } from "./handover/marks.ts";
import { listen } from "./server.ts";
import type { BrainFound } from "./hello/stage.ts";
import { plainTelling, type Telling } from "./hello/telling.ts";
import { canOpenBrowser, noteBrowserTry, openBrowser } from "./open-browser.ts";
import { runningAuni, runsAs, where } from "./running.ts";
import { auniCommand } from "./setup.ts";
import { startWebApp } from "./web-app.ts";

/**
 * `auni`: the whole of Auni as one process. The database is ready (boot.ts); this brings it to
 * this version's schema, then starts the job runner, the API and the web app, and brings the
 * owner's browser to it. Ctrl-C (or SIGTERM) stops them in the order that lets a send in flight
 * finish, as does `auni stop` (running.ts). When Auni already runs on this database, it only
 * brings the browser to that one.
 *
 * Without `jobs`, nothing runs in the background: no move is sent, no turn or watch runs. That is
 * how `auni update` sees a new version come up (release/update.ts), since a roll back puts the
 * database back as it was, and so would undo whatever a job did meanwhile, a send among them.
 */
export async function start(
  database: Postgres | null,
  options: {
    readonly web: boolean;
    readonly open: boolean;
    readonly jobs: boolean;
    /** Runs once core's jobs and API are up, before the web app starts: a demo seeds itself here. */
    readonly onceUp?: () => Promise<void>;
    /** Prints the pairing link where no browser opens: only a demo's, whose owner is made up. */
    readonly printsLink?: boolean;
    /** How to stop when it runs without a terminal. */
    readonly stopHint?: string;
    /** The page of the app the browser is brought to, where it isn't the app's first. */
    readonly landsOn?: string;
    /** How the start is told: the terminal's scene, or plain lines (hello/telling.ts). */
    readonly told?: Telling;
  },
): Promise<void> {
  proveLogins();
  const told = options.told ?? plainTelling((line) => console.log(line));
  // Asked now, beside everything else, and told the moment it's known, so knowing what Auni
  // thinks with never slows it down.
  void brainFound().then((found) => {
    told.brain(found);
    if (found.name) return;
    // None here yet: the owner signs one in from the browser, and is told so here too.
    let heard = false;
    const off = onBrainReady(
      () =>
        void brainFound().then((later) => {
          if (!later.name || heard) return;
          heard = true;
          off();
          told.brain(later);
        }),
    );
  });
  const { web, open, jobs: runJobs, onceUp, printsLink = false, landsOn } = options;
  let runner: Runner | undefined;
  let servers: Server[] = [];
  let webApp: ChildProcess | undefined;
  let stopping = false;

  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    try {
      // The terminal back first, for what's said as Auni stops; inside, so nothing it throws
      // skips stopping Postgres.
      told.abandon();
      // So an Auni started meanwhile waits for this one's Postgres to stop, and runs its own.
      await database?.stopping();
      if (runner)
        console.log(
          `Stopping Auni. Moves in progress will finish first${runsAs() === "terminal" ? " (press Ctrl-C again to stop immediately)" : ""}.`,
        );
      webApp?.kill();
      // No new requests; one in flight, such as a money tool call waiting on its send, carries on.
      for (const server of servers) server.close();
      // Turns end now; other jobs (a send in flight among them) get up to two minutes.
      await runner?.stop();
      for (const server of servers) server.closeAllConnections();
      await closeDatabaseConnection();
      await database?.release();
    } catch (error) {
      // Stopping ends in an exit whatever failed on the way, said once, never an unhandled crash.
      console.error("Auni stopped with an error:", error);
      code = 1;
    }
    process.exit(code);
  };
  onStopAsked(() => void stop(0));
  // Auni's own Postgres stopped under it (killed, crashed, stopped by hand, or with everything
  // as a machine shuts down, while Auni stops): nothing starts it again for this process and
  // nothing left can be recorded, so Auni stops at once, as a crash would, and its service (or
  // the owner) starts it again with a Postgres of its own. What was running is settled as cut off
  // as it starts (jobs/AGENTS.md); a send is journalled before it's broadcast, so one cut off
  // goes out as it was signed, never signed again (money/AGENTS.md).
  void database?.stopped.then(() => {
    stopping = true;
    told.abandon();
    console.error(
      `Auni's database stopped, so Auni is stopping too. A move in progress may still have gone through. Check its card after Auni restarts. See ${postgresLog()}. ${runsAs() === "service" ? "Its background service will restart it." : `Run ${auniCommand()} to start it again.`}`,
    );
    webApp?.kill();
    process.exit(1);
  });

  if (takingOver()) {
    console.error(
      "Auni is still moving from the other computer and isn't ready yet. Run the auni take-over command again to finish.",
    );
    return void (await stop(1));
  }
  // Moved to another machine, this copy runs nothing: its page sends the owner there.
  const handed = handedOver();
  try {
    await migrateDatabase(env.DATABASE_URL);
    told.memoryReady();
    // The terminal's hop plays in full while the owner's first take is still ahead.
    told.firstRun(
      await theOwner().then(
        ({ welcomedAt }) => welcomedAt === null,
        () => true,
      ),
    );
    if (handed) {
      // Held, so this copy still counts as the Auni here (auni stop, a second auni), running nothing.
      const held = await takeRunnerLock(() => {});
      if (!held) throw new AlreadyRunning();
      runner = { stop: () => held.close() };
      console.log(
        `Auni moved to ${handed.machine} (${handed.to}), so this copy is paused. Your local data and keys stay here until you run auni uninstall.`,
      );
    } else if (runJobs) {
      runner = await startRunnerWhenFree(jobs, coreServing, {
        onWait: () =>
          told.waiting(
            "A previous Auni process is still finishing work in progress. Starting as soon as it finishes.",
          ),
      });
      // A handover to another machine stops the runner while it hands Auni over (handover/).
      lendToHandover({
        stopJobs: async () => {
          const was = runner;
          runner = undefined;
          await was?.stop();
        },
        startJobs: async () => {
          if (!stopping) runner ??= await startRunner(jobs);
        },
        pack: packHere,
      });
    } else told.say("Background work is off.");
    servers = await listen();
    if (env.TAILSCALE_OWNER) told.log("Tailscale access is ready.");
    await onceUp?.();
    if (!web) told.log(`API ready at http://${env.HOST}:${env.PORT}`);
    if (web) {
      // Its banner and chatter never reach the terminal, scene or plain: only Auni's own lines do.
      webApp = await startWebApp({ quiet: true, onBuild: () => told.pageBuilding() });
      webApp.once("exit", (exitCode) => {
        if (stopping) return;
        told.abandon();
        console.error(`The web app exited (code ${exitCode}), so Auni is stopping too.`);
        void stop(exitCode || 1);
      });
    }
    told.pageReady();
  } catch (error) {
    told.abandon();
    if (error instanceof AlreadyRunning) {
      const holder = await runningAuni();
      console.log(
        holder ? `Auni is already running ${where(holder)}.` : "Auni is already running.",
      );
      await openOwner({ web, open, printsLink, landsOn });
      await stop(0);
      return;
    }
    if (error instanceof StillStopping) console.log(error.message);
    else {
      console.error(`Auni couldn't start. Run ${auniCommand()} doctor\n`);
      console.error(error);
    }
    await stop(1);
    return;
  }

  const opened = await openOwner({
    web,
    open,
    printsLink,
    landsOn,
    say: told.say,
    // Auni leaps into the browser as it opens, filling the moment it takes to come up.
    opening: () => told.leaving(),
  }).catch((error: unknown) => {
    told.abandon();
    console.error(`Couldn't open Auni in your browser. Run ${auniCommand()} doctor\n`, error);
    return false;
  });
  const mode = runsAs();
  if (mode === "terminal") told.say("Keep this terminal open. Ctrl-C stops Auni.");
  else if (options.stopHint) told.say(options.stopHint);
  else if (!runJobs && !handed) told.say("Stop this process to shut down Auni.");
  else told.say(`Auni is running ${where({ as: mode })}. Stop it with ${auniCommand()} stop.`);
  told.up(opened);
}

/**
 * Calls `stop` each time Auni is asked to stop. SIGTERM (`auni stop`, a service's stop) stops
 * gently however often it comes, so asking again never cuts a send short; a second Ctrl-C stops
 * at once. A Ctrl-C reaches every process in the terminal's group, and pnpm also passes it on,
 * so one press can arrive twice: only one a second or more later is a second press. Closing the
 * terminal window hangs up on Auni (SIGHUP), which Node would otherwise die of at once, leaving
 * its Postgres running, since pg_ctl started that in a session of its own: it stops gently too,
 * with nowhere left to print, so a write to the closed terminal can't kill it on the way.
 */
export function onStopAsked(stop: () => void, signals: NodeJS.EventEmitter = process): void {
  let firstInterrupt = 0;
  signals.on("SIGTERM", stop);
  signals.on("SIGHUP", () => {
    for (const out of [process.stdout, process.stderr]) out.on("error", () => {});
    stop();
  });
  signals.on("SIGINT", () => {
    if (!firstInterrupt) {
      firstInterrupt = Date.now();
      stop();
    } else if (Date.now() - firstInterrupt > 1_000) process.exit(130);
  });
}

/** Whether an Auni serves this machine's API port: one that is stopping has closed it. */
async function coreServing(): Promise<boolean> {
  return fetch(`http://${env.HOST}:${env.PORT}/health`, {
    signal: AbortSignal.timeout(2_000),
  }).then(
    () => true,
    () => false,
  );
}

/**
 * Opens Auni in this machine's browser: with no browser paired yet, the one-time pairing link,
 * which signs that browser in as the owner's; after that, the app. The link goes to the browser
 * and never to this output, so a coding agent that runs `auni` never reads a credential. With
 * nothing to open it in, it says where Auni is and how to get a link; a demo, whose owner is
 * made up, prints its link instead (`printsLink`). Either way the browser lands on `landsOn`.
 */
export async function openOwner({
  web,
  open,
  printsLink = false,
  landsOn = "/app",
  say = (line) => console.log(line),
  opening = () => {},
}: {
  readonly web: boolean;
  readonly open: boolean;
  readonly printsLink?: boolean;
  readonly landsOn?: string | undefined;
  /** Where its lines go: printed, or kept under the terminal's scene (hello/telling.ts). */
  readonly say?: (line: string) => void;
  /** Told as the browser opens: the terminal's Auni leaps into it. */
  readonly opening?: () => void;
}): Promise<boolean> {
  if (!web) return false;
  // Through Tailscale there is nothing to pair, and this machine's own browser is never let in.
  if (env.TAILSCALE_OWNER) {
    say(`\nOpen Auni from a device signed in to Tailscale.\n${env.WEB_ORIGIN}`);
    return false;
  }
  const paired = (await lastPaired()) !== null;
  const screen = canOpenBrowser();
  if (open && screen) {
    const url = paired
      ? `${env.WEB_ORIGIN}${landsOn}`
      : pairingLink(await mintPairingCode(), landsOn);
    opening();
    const opened = await openBrowser(url).then(
      () => true,
      () => false,
    );
    if (opened) {
      noteBrowserTry("opened");
      say(`\nAuni is open in your browser.\n${env.WEB_ORIGIN}`);
      return true;
    }
  }
  noteBrowserTry(open && !screen ? "no-screen" : "not-opened");
  if (paired) {
    say(`\nOpen Auni at ${env.WEB_ORIGIN}`);
    return false;
  }
  say(
    printsLink
      ? `\nOpen ${pairingLink(await mintPairingCode(), landsOn)}\nThis link works once and expires after 15 minutes.`
      : `\nAuni is at ${env.WEB_ORIGIN}\nRun ${auniCommand()} pair to get a sign-in link.`,
  );
  return false;
}

/**
 * What turns will think with, as each brain's check sees it, or what the owner runs so something
 * can. A running Auni goes on to prove the login with one tiny question (proveLogins), which its
 * first turn waits on; saying what the check saw needn't.
 */
async function brainFound(): Promise<BrainFound> {
  const picked = await brainSeen().catch((error: unknown) => {
    console.error("Couldn't check your AI:", error);
    return { fixes: [] as string[] };
  });
  return "about" in picked
    ? {
        name: picked.about.name,
        line: `Your AI: ${picked.about.name} ready.`,
      }
    : {
        name: null,
        line: picked.fixes.length
          ? picked.fixes.join("\n")
          : "Couldn't check your AI. Open Settings to check your sign-in.",
      };
}
