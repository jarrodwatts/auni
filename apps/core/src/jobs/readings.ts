import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.ts";
import { valueSnapshots } from "../db/schema.ts";
import { readPortfolio } from "../money/portfolio.ts";
import { askForReading, readingDue } from "../money/readings.ts";
import { sweepArrivals } from "../money/sweep.ts";
import { hasWallet } from "../money/wallets.ts";
import { readingKind } from "./kinds.ts";
import { defineJob, jobKind } from "./queue.ts";

/**
 * Takes a reading of the portfolio when one is due (see readingDue), first
 * sweeping the wallets for money that moved (see sweepArrivals), so even an
 * owner who never opens Auni has a deposit counted within a day. Nothing
 * before the wallet has keys: there is no money, and reading would make them.
 */
export const readingJob = defineJob({
  kind: readingKind,
  run: async () => {
    if (!(await hasWallet())) return;
    await sweepArrivals();
    // Checked first too, so a reading taken since it was asked for costs no venue a read.
    if (!(await readingDue(db, new Date()))) return;
    // The read keeps itself as the reading.
    await readPortfolio();
  },
});

/** How long without a reading before the backstop asks for one. */
const BACKSTOP_AFTER_HOURS = 20;

/** Whether no reading was kept in 20 hours, or none ever. */
export async function readingOverdue(): Promise<boolean> {
  const [last] = await db
    .select({
      overdue: sql<boolean>`coalesce(max(${valueSnapshots.takenAt}) < now() - make_interval(hours => ${BACKSTOP_AFTER_HOURS}), true)`,
    })
    .from(valueSnapshots);
  return last?.overdue ?? true;
}

/**
 * Every hour, asks for a reading when none was kept in 20 hours, so there is
 * one a day even if the owner never opens Auni.
 */
export const readingBackstopJob = defineJob({
  kind: jobKind("reading-backstop", z.object({})),
  every: 60 * 60_000,
  run: async () => {
    if ((await hasWallet()) && (await readingOverdue())) await askForReading(db);
  },
});
