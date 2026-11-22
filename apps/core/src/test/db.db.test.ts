import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, fills } from "../db/schema.ts";
import { wipe } from "./db.ts";

// As sweep.db.test.ts's "sweeps nothing while the lists can't be read" left it: the sweep threw
// while a select of fills joined to actions was still going, and the next test truncated.
it("empties the tables though a query the last test left running deadlocks with it", async () => {
  let wiping: Promise<void> | undefined;
  const straggler = db
    .transaction(async (tx) => {
      await tx.select().from(fills).limit(1);
      wiping = wipe(fills);
      // The truncate holds actions, and waits for fills, which the straggler holds.
      await vi.waitFor(
        async () => {
          const [waiting] = await db.execute<{ count: number }>(
            sql`select count(*)::int as count from pg_stat_activity
                where wait_event_type = 'Lock' and query like 'truncate threads, actions, % fills cascade'`,
          );
          expect(waiting!.count).toBe(1);
        },
        { timeout: 5_000 },
      );
      await tx.select().from(actions).limit(1);
    })
    .catch(() => {});
  await straggler;
  await expect(wiping).resolves.toBeUndefined();
});
