import { EVM_CHAIN_KEYS } from "@auni/shared";

import { ctrlCHandler } from "../ctrl-c.ts";
import type { Postgres } from "../db/embedded.ts";
import { demoEnvironment, takeHome } from "./home.ts";
import { standInForTheWorld } from "./world.ts";

// `auni demo`: the whole of Auni, started as `auni` starts it, with three things stood in for.
//
//   the brain    a script that calls Auni's real tools             demo/brain.ts, scenes.ts
//   the wallet   signs for no real network, sends to the ledger    demo/wallet.ts
//   the world    every outside API and chain, answered here        demo/world.ts, world/
//
// Started `--at` a moment, its clock is stood in for too (demo/clock.ts).
//
// Everything between them is the real code: the tools, the recipes, the cards, the job runner,
// the portfolio and the web app. The owner it shows is made by playing a script of ordinary
// requests through that code as it starts (demo/seed.ts), the same on every run.

/**
 * Starts a demo and runs until stopped. Only this file's own imports may come before the
 * environment is the demo's: everything else of core is loaded after, by `await import`.
 */
export async function startDemo({
  port,
  web,
  open,
  at,
  firstRun = false,
}: {
  readonly port: number;
  readonly web: boolean;
  readonly open: boolean;
  /** The moment its clock stops at once its owner is made (demo/clock.ts); the real clock without. */
  readonly at?: number | undefined;
  /** A new owner's first run: no past, no money, their first take ahead (first-run.ts). */
  readonly firstRun?: boolean;
}): Promise<void> {
  console.log(
    "Demo mode. Fake money only; your real data is untouched.\n" +
      (firstRun
        ? 'Try a first take: "Peptides go mainstream by 2028".'
        : 'Tap "Take the tour" once Auni opens.') +
      "\nNever send real money to a demo address.\n\nStarting the demo.",
  );
  // During boot, wait for Postgres to finish starting before stopping it and removing its
  // files. start() installs Auni's regular shutdown handlers before it first yields.
  let interrupted = false;
  let database: Postgres | undefined;
  const interrupt = () => {
    interrupted = true;
  };
  const ctrlC = ctrlCHandler(
    () => {
      interrupt();
      process.exitCode = 130;
    },
    () => {
      // Once Postgres is up, the exit handler can find the server to stop it.
      if (database) process.exit(130);
    },
  );
  process.on("SIGINT", ctrlC);
  process.on("SIGTERM", interrupt);
  process.on("SIGHUP", interrupt);
  try {
    const { home, ports } = await demoEnvironment(port, [...EVM_CHAIN_KEYS, "solana"]);
    if (interrupted) return;
    takeHome(home);
    const { openPostgres } = await import("../db/embedded.ts");

    const { auniLog, keptSecret } = await import("../data-dir.ts");
    if (interrupted) return;
    process.env.TURN_TOKEN_SECRET = keptSecret("turn-token-secret");
    database = await openPostgres({ runsAuni: true });
    if (interrupted) return;
    process.env.DATABASE_URL = database.url;
    // Before anything that reads the time is loaded, and before core makes its tables.
    if (at !== undefined) await (await import("./clock.ts")).startClock(at, database.url);

    const { services } = await import("./world/index.ts");
    standInForTheWorld(services, ports);
    const { standInForCommands } = await import("./world/commands.ts");
    standInForCommands(home);
    const { standIn } = await import("../apps/registry.ts");
    const { demoApps } = await import("./app.ts");
    standIn(demoApps);

    const { start } = await import("../start.ts");
    const { takeOutput } = await import("../hello/telling.ts");
    const { seed } = firstRun ? await import("./first-run.ts") : await import("./seed.ts");
    // The browser lands on a new chat: first run's question, or one whose first starting point is
    // the tour (tour.ts).
    if (interrupted) return;
    const started = start(database, {
      web,
      open,
      jobs: true,
      onceUp: async () => {
        if (firstRun) return seed();
        console.log("Preparing sample takes.");
        // The sample history plays real jobs. Keep their diagnostics in the demo log and show
        // them in the terminal if setup fails.
        const output = takeOutput(process.stdout, process.stderr);
        try {
          await seed();
          output.toLog(auniLog());
        } finally {
          output.toTerminal();
        }
      },
      printsLink: true,
      stopHint: "Stop this process to end the demo.",
      landsOn: "/app/new",
    });
    database = undefined; // start() now handles shutdown and owns the database.
    return started;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    try {
      if (database) await database.release();
    } finally {
      process.off("SIGINT", ctrlC);
      process.off("SIGTERM", interrupt);
      process.off("SIGHUP", interrupt);
    }
  }
}
