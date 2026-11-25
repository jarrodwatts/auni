import type { takesWireSchema } from "@auni/shared";
import { inArray } from "drizzle-orm";
import type { z } from "zod";

import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { threads } from "../db/schema.ts";
import { allFills, costCents, holdingsByThread, worthUsd } from "./books.ts";
import { holdingViews } from "./holdings.ts";
import { portfolioNow, type Holding } from "./portfolio.ts";
import { centsToUsd, usdToCents } from "./usd.ts";
import { startOfDay } from "./value-history.ts";

/**
 * The owner's takes: each thread that holds something now, by the fills Auni recorded in it,
 * with what it holds, what that is worth and what it has made; and what no take holds.
 */
export async function readTakes(): Promise<z.input<typeof takesWireSchema>> {
  const [portfolio, everyFill, { timeZone }] = await Promise.all([
    portfolioNow(),
    allFills(db),
    theOwner(),
  ]);
  const split = holdingsByThread(portfolio.assets.holdings, everyFill);
  const ids = [...split.threads.keys()];
  const titles = new Map(
    ids.length === 0
      ? []
      : (
          await db
            .select({ id: threads.id, title: threads.title })
            .from(threads)
            .where(inArray(threads.id, ids))
        ).map(({ id, title }) => [id, title?.trim() || "Untitled take"]),
  );
  const today = startOfDay(timeZone);
  const takes = await Promise.all(
    [...split.threads].map(async ([threadId, held]) => ({
      threadId,
      title: titles.get(threadId) ?? "Untitled take",
      valueUsd: worthUsd(held),
      ...takeChange(held),
      holdings: await holdingViews(held, today),
    })),
  );
  return {
    // A take whose holdings are all crumbs too small to show holds nothing worth a row.
    takes: takes
      .filter((take) => take.holdings.length > 0)
      .toSorted((a, b) => Number(usdToCents(b.valueUsd) - usdToCents(a.valueUsd))),
    loose: await holdingViews(split.loose, today),
  };
}

/**
 * What a take's holdings have made since they were bought, over what they cost, counting only
 * the ones whose cost is known; null for both when none is.
 */
function takeChange(held: readonly Holding[]): {
  changeUsd: string | null;
  costUsd: string | null;
} {
  let cost = 0n;
  let value = 0n;
  let known = false;
  for (const holding of held) {
    const cents = costCents(holding);
    if (cents === null || holding.usdValue === null) continue;
    known = true;
    cost += cents;
    value += usdToCents(holding.usdValue);
  }
  if (!known) return { changeUsd: null, costUsd: null };
  return { changeUsd: centsToUsd(value - cost), costUsd: centsToUsd(cost) };
}
