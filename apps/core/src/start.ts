import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

import { brainSeen, onBrainReady, proveLogins, terminalBrainLine } from "./agent/brain.ts";
import { lastPaired, mintPairingCode, pairingLink, theOwner } from "./auth/owner.ts";
import { onStopAsked } from "./ctrl-c.ts";
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
import { takeBackStale } from "./money/waiting.ts";
import { takingOver, handedOver } from "./handover/marks.ts";
import { listen } from "./server.ts";
import { plainTelling, type Telling } from "./hello/telling.ts";
import { canOpenBrowser, noteBrowserTry, openBrowser } from "./open-browser.ts";
import { runningAuni, runsAs, where } from "./running.ts";
import { auniCommand, tunnelHint } from "./setup.ts";
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
    readonly onceUp?: (signal: AbortSignal) => Promise<void>;
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
  const { web, open, jobs: runJobs, onceUp, printsLink = false, landsOn } = options;
  let runner: Runner | undefined;
  let servers: Server[] = [];
  let webApp: ChildProcess | undefined;
  let stopping = false;
  let runnerDrain: Promise<void> | undefined;
  const cancelling = new AbortController();

  // Asked now, beside everything else, and told the moment it's known, so knowing what Auni
  // thinks with never slows it down.
  void brainFound().then((found) => {
    if (stopping) return;
    told.brain(found);
    if (found.name) return;
    // None here yet: the owner signs one in from the browser, and is told so here too.
    let heard = false;
    const off = onBrainReady(
      () =>
        void brainFound().then((later) => {
          if (stopping || !later.name || heard) return;
          heard = true;
          off();
          told.brain(later);
        }),
    );
  });

  const closeListeners = () => {
    webApp?.kill();
    webApp = undefined;
    // No new requests; one in flight, such as a money tool call waiting on its send, carries on.
    // Called again once startup settles; closing a closed server does nothing.
    for (const server of servers) server.close();
  };
  const drainRunner = (): Promise<void> | undefined => {
    if (runner && !runnerDrain) {
      console.log(
        `Stopping Auni. Moves in progress will finish first${runsAs() === "terminal" ? " (press Ctrl-C again to stop immediately)" : ""}.`,
      );
      // Turns end now; other jobs (a send in flight among them) get up to two minutes.
      runnerDrain = runner.stop();
    }
    return runnerDrain;
  };

  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    cancelling.abort();
    try {
      // The terminal back first, for what's said as Auni stops; inside, so nothing it throws
      // skips stopping Postgres.
      told.abandon();
      // Stop admitting new requests and new jobs at once, while any in-flight startup step unwinds
      // alongside and Postgres stays up until both are done.
      closeListeners();
      const firstDrain = drainRunner();
      // So an Auni started meanwhile waits for this one's Postgres to stop, and runs its own.
      const dbStopping = database?.stopping();
      // Anything startup finished creating just as the stop began is closed and drained as soon as
      // startup settles, without waiting for an earlier long drain.
      const startupDone = startup.then(() => {
        closeListeners();
        return drainRunner();
      });
      const results = await Promise.allSettled([dbStopping, firstDrain, startupDone]);
      const failed = results.find((r) => r.status === "rejected");
      for (const server of servers) server.closeAllConnections();
      await closeDatabaseConnection();
      await database?.release();
      if (failed) throw failed.reason;
    } catch (error) {
      // Stopping ends in an exit whatever failed on the way, said once, never an unhandled crash.
      console.error("Auni stopped with an error:", error);
      code = 1;
    }
    offStop();
    process.exit(code);
  };
  const offStop = onStopAsked((code) => void stop(code));
  // Auni's own Postgres stopped under it (killed, crashed, stopped by hand, or with everything
  // as a machine shuts down, while Auni stops): nothing starts it again for this process and
  // nothing left can be recorded, so Auni stops at once, as a crash would, and its service (or
  // the owner) starts it again with a Postgres of its own. What was running is settled as cut off
  // as it starts (jobs/AGENTS.md); a send is journalled before it's broadcast, so one cut off
  // goes out as it was signed, never signed again (money/AGENTS.md).
  void database?.stopped.then(() => {
    if (stopping) return;
    stopping = true;
    offStop();
    told.abandon();
    console.error(
      `Auni's database stopped, so Auni is stopping too. A move in progress may still have gone through. Check its card after Auni restarts. See ${postgresLog()}. ${runsAs() === "service" ? "Its background service will restart it." : `Run ${auniCommand()} to start it again.`}`,
    );
    webApp?.kill();
    process.exit(1);
  });

  // Never calls stop() itself so stop() can safely await it without deadlocking; returns an exit
  // code when startup ends early (error, already running, taking over), or null otherwise.
  // Deferred one microtask so `startup` is always assigned before any step can trigger `stop()`.
  const startup = Promise.resolve().then(async (): Promise<number | null> => {
    if (stopping) return null;
    if (takingOver()) {
      console.error(
        "Auni is still moving from the other computer and isn't ready yet. Run the auni take-over command again to finish.",
      );
      return 1;
    }
    // Moved to another machine, this copy runs nothing: its page sends the owner there.
    const handed = handedOver();
    try {
      await migrateDatabase(env.DATABASE_URL, cancelling.signal);
      if (stopping) return null;
      told.memoryReady();
      // The terminal's hop plays in full while the owner's first take is still ahead.
      const first = await theOwner().then(
        ({ welcomedAt }) => welcomedAt === null,
        () => true,
      );
      if (stopping) return null;
      told.firstRun(first);
      if (handed) {
        // Held, so this copy still counts as the Auni here (auni stop, a second auni), running nothing.
        const held = await takeRunnerLock(() => {});
        if (held) runner = { stop: () => held.close() };
        if (stopping) return null;
        if (!held) throw new AlreadyRunning();
        console.log(
          `Auni moved to ${handed.machine} (${handed.to}), so this copy is paused. Your local data and keys stay here until you run auni uninstall.`,
        );
      } else if (runJobs) {
        runner = await startRunnerWhenFree(jobs, () => coreServing(cancelling.signal), {
          onWait: () =>
            told.waiting(
              "A previous Auni process is still finishing work in progress. Starting as soon as it finishes.",
            ),
          signal: cancelling.signal,
        });
        if (stopping) return null;
        // Before any tab can see one: a card from before this version doesn't wait looking allowable.
        await takeBackStale();
        if (stopping) return null;
        // A handover to another machine stops the runner while it hands Auni over (handover/).
        lendToHandover({
          stopJobs: async () => {
            // Kept until drained, so a stop asked meanwhile waits on the same drain.
            await runner?.stop();
            runner = undefined;
          },
          startJobs: async () => {
            if (stopping || runner) return;
            const next = await startRunner(jobs, { signal: cancelling.signal });
            if (stopping) await next.stop();
            else runner = next;
          },
          pack: packHere,
          signal: cancelling.signal,
        });
      } else told.say("Background work is off.");
      servers = await listen();
      if (stopping) return null;
      if (env.TAILSCALE_OWNER) told.log("Tailscale access is ready.");
      await onceUp?.(cancelling.signal);
      if (stopping) return null;
      if (!web) told.log(`API ready at http://${env.HOST}:${env.PORT}`);
      if (web) {
        // Its banner and chatter never reach the terminal, scene or plain: only Auni's own lines do.
        webApp = await startWebApp({
          quiet: true,
          onBuild: () => told.pageBuilding(),
          signal: cancelling.signal,
        });
        if (stopping) return null;
        webApp.once("exit", (exitCode) => {
          if (stopping) return;
          told.abandon();
          console.error(`The web app exited (code ${exitCode}), so Auni is stopping too.`);
          void stop(exitCode || 1);
        });
      }
      told.pageReady();
    } catch (error) {
      // A process-group signal can kill a synchronous child (e.g. git in buildVersion) and throw
      // before libuv delivers the signal here; yield one turn so onStopAsked runs first.
      if (!stopping) await new Promise<void>((resolve) => setImmediate(resolve));
      // A stop the owner asked for cancels whatever step was in flight; stop() cleans up and exits.
      if (stopping) return null;
      told.abandon();
      if (error instanceof AlreadyRunning) {
        const holder = await runningAuni();
        if (stopping) return null;
        console.log(
          holder ? `Auni is already running ${where(holder)}.` : "Auni is already running.",
        );
        await openOwner({ web, open, printsLink, landsOn, signal: cancelling.signal });
        if (stopping) return null;
        return 0;
      }
      if (error instanceof StillStopping) console.log(error.message);
      else {
        console.error(`Auni couldn't start. Run ${auniCommand()} doctor\n`);
        console.error(error);
      }
      return 1;
    }

    if (stopping) return null;
    const opened = await openOwner({
      web,
      open,
      printsLink,
      landsOn,
      say: told.say,
      // Auni leaps into the browser as it opens, filling the moment it takes to come up.
      opening: () => told.leaving(),
      signal: cancelling.signal,
    }).catch((error: unknown) => {
      if (stopping) return false;
      told.abandon();
      console.error(`Couldn't open Auni in your browser. Run ${auniCommand()} doctor\n`, error);
      return false;
    });
    if (stopping) return null;
    const mode = runsAs();
    if (mode === "terminal") told.say("Keep this terminal open. Ctrl-C stops Auni.");
    else if (options.stopHint) told.say(options.stopHint);
    else if (!runJobs && !handed) told.say("Stop this process to shut down Auni.");
    else told.say(`Auni is running ${where({ as: mode })}. Stop it with ${auniCommand()} stop.`);
    told.up(opened);
    return null;
  });

  const earlyExit = await startup;
  if (earlyExit !== null) await stop(earlyExit);
}

/** Whether an Auni serves this machine's API port: one that is stopping has closed it. */
async function coreServing(signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(2_000);
  return fetch(`http://${env.HOST}:${env.PORT}/health`, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
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
  signal,
}: {
  readonly web: boolean;
  readonly open: boolean;
  readonly printsLink?: boolean;
  readonly landsOn?: string | undefined;
  /** Where its lines go: printed, or kept under the terminal's scene (hello/telling.ts). */
  readonly say?: (line: string) => void;
  /** Told as the browser opens: the terminal's Auni leaps into it. */
  readonly opening?: () => void;
  /** Cancels waiting on the browser opener when Auni is stopping. */
  readonly signal?: AbortSignal | undefined;
}): Promise<boolean> {
  if (!web || signal?.aborted) return false;
  // Through Tailscale there is nothing to pair, and this machine's own browser is never let in.
  if (env.TAILSCALE_OWNER) {
    say(`\nOpen Auni from a device signed in to Tailscale.\n${env.WEB_ORIGIN}`);
    return false;
  }
  const paired = (await lastPaired()) !== null;
  if (signal?.aborted) return false;
  const screen = canOpenBrowser();
  if (open && screen) {
    const url = paired
      ? `${env.WEB_ORIGIN}${landsOn}`
      : pairingLink(await mintPairingCode(), landsOn);
    if (signal?.aborted) return false;
    opening();
    const opened = await openBrowser(url, signal).then(
      () => true,
      () => false,
    );
    if (signal?.aborted) return false;
    if (opened) {
      noteBrowserTry("opened");
      say(`\nAuni is open in your browser.\n${env.WEB_ORIGIN}`);
      return true;
    }
  }
  noteBrowserTry(open && !screen ? "no-screen" : "not-opened");
  const tunnel = screen ? "" : tunnelHint();
  const link = paired
    ? `Open Auni at ${env.WEB_ORIGIN}`
    : printsLink
      ? `Open ${pairingLink(await mintPairingCode(), landsOn)}\nThis link works once and expires after 15 minutes.`
      : `Auni is at ${env.WEB_ORIGIN}\nRun ${auniCommand()} pair to get a sign-in link.`;
  if (signal?.aborted) return false;
  say(`\n${tunnel}${link}`);
  return false;
}

/**
 * What turns will think with, as each brain's check sees it, or what the owner runs so something
 * can. A running Auni goes on to prove the login with one tiny question (proveLogins), which its
 * first turn waits on; saying what the check saw needn't.
 */
function brainFound() {
  const auni = auniCommand();
  return brainSeen(auni).catch(() => ({
    name: null,
    line: terminalBrainLine(undefined, null, auni),
  }));
}
