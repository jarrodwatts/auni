import { z } from "zod";

import { awaitingDeposit, sweepWhenDue } from "../money/sweep.ts";
import { defineJob, jobKind } from "./queue.ts";

/**
 * Every minute, sweeps the owner's wallets for money that moved when they're
 * due (see sweepWhenDue): each minute while a thread waits for a deposit, so it
 * wakes when the money lands with the app closed, and every 15 minutes
 * otherwise, so what they're sent is told of within the quarter hour. Nothing
 * before the wallet has keys: a sweep reads its addresses, which would make them.
 */
export const sweepJob = defineJob({
  kind: jobKind("sweep", z.object({})),
  every: 60_000,
  run: async () => sweepWhenDue(await awaitingDeposit()),
});
