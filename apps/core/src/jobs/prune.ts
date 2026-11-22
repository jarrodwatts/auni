import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.ts";
import { defineJob, jobKind } from "./queue.ts";

/**
 * Daily, forgets jobs that finished more than two weeks ago. A key dedupes only while its job
 * is kept, so two weeks is far past any repeat of the same cause.
 */
export const pruneJob = defineJob({
  kind: jobKind("prune", z.object({})),
  every: 24 * 60 * 60_000,
  run: async () => {
    await db.execute(sql`delete from jobs where finished_at < now() - interval '14 days'`);
  },
});
