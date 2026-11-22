// The new machine's half of a handover in a process of its own, as `auni take-over` runs it,
// for handover/handover.db.test.ts: its own AUNI_HOME and DATABASE_URL, the code in AUNI_HANDOVER_CODE.
// `take-over-child.ts <from> [--finish]`. What it says goes to stdout; a refusal's words to stderr,
// exiting 1. Always on, it would be at box's tailnet name on 8444, as where 443 is taken;
// ALWAYS_ON_AT names another address, or "none" for a machine that can't be always on yet.
import { walletApp } from "../apps/registry.ts";
import { closeDatabaseConnection } from "../db/client.ts";
import { env } from "../env.ts";
import { takeOver, TakeOverRefused } from "../handover/take-over.ts";

const [from = "", finish] = process.argv.slice(2);
const { about, provided } = walletApp();
try {
  await takeOver(
    { from, code: process.env.AUNI_HANDOVER_CODE ?? "", finish: finish === "--finish" },
    {
      databaseUrl: env.DATABASE_URL,
      wallet: { app: about.id, provided },
      alwaysOnAt: async () => {
        if (process.env.ALWAYS_ON_AT === "none")
          throw new TakeOverRefused("This machine can't keep Auni on yet: Tailscale is off.");
        return {
          address: process.env.ALWAYS_ON_AT ?? "https://box.tail1234.ts.net:8444",
          port: 8444,
        };
      },
    },
  );
} catch (error) {
  if (!(error instanceof TakeOverRefused)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await closeDatabaseConnection();
}
