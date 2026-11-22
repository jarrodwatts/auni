import { EVM_CHAIN_KEYS } from "@auni/shared";

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
  const { home, ports } = await demoEnvironment(port, [...EVM_CHAIN_KEYS, "solana"]);
  takeHome(home);
  const { openPostgres } = await import("../db/embedded.ts");

  const { keptSecret } = await import("../data-dir.ts");
  process.env.TURN_TOKEN_SECRET = keptSecret("turn-token-secret");
  const database = await openPostgres({ runsAuni: true });
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

  console.log(
    "This is a demo of Auni. Its owner, its money and its AI are made up: nothing of yours is read,\n" +
      "changed or sent anywhere, and only the stocks' logos come in from outside. It keeps its data\n" +
      `in ${home}\n` +
      "and removes it when it stops. Never send money to an address it shows: its wallet is nobody's.\n\n" +
      (firstRun
        ? "It starts as a new owner's first run. Say what you believe: it knows one take by heart,\n" +
          '"Peptides go mainstream by 2028".\n'
        : "New here? The page that opens offers a tour: ten minutes through everything Auni does.\n"),
  );
  const { start } = await import("../start.ts");
  const { seed } = firstRun ? await import("./first-run.ts") : await import("./seed.ts");
  // The browser lands on a new chat: first run's question, or one whose first starting point is
  // the tour (tour.ts).
  await start(database, {
    web,
    open,
    jobs: true,
    onceUp: seed,
    printsLink: true,
    landsOn: "/app/new",
  });
}
