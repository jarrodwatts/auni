import { z } from "zod";

import { attempt } from "../app-troubles.ts";
import { statementSweeps } from "../money/statements.ts";
import { walletAddresses } from "../money/wallets.ts";
import { defineJob, jobKind } from "./queue.ts";

/**
 * Every hour, reads each perps venue's statement when Auni trades there and it
 * wasn't read lately (see statementSweeps), so what a venue did by itself, a
 * liquidation say, is recorded within the hour even if the owner never opens
 * Auni, whose sweep would otherwise find it. The wallet is asked for its
 * address only once one is due, so this never makes keys.
 */
export const statementsJob = defineJob({
  kind: jobKind("statements", z.object({})),
  every: 60 * 60_000,
  run: async () => {
    // One that fails is said on its app's sheet and in doctor until it reads again.
    for (const { app, work, run } of statementSweeps(async () => (await walletAddresses()).evm))
      await attempt(app, work, run).catch(() => undefined);
  },
});
