import { appListing, type takesWireSchema } from "@auni/shared";
import { inArray } from "drizzle-orm";
import type { z } from "zod";

import { isSavings } from "../apps/registry.ts";
import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { threads } from "../db/schema.ts";
import { allFills, gainOf, holdingsByThread, worthUsd } from "./books.ts";
import { holdingViews } from "./holdings.ts";
import { portfolioNow, type Holding, type Portfolio } from "./portfolio.ts";
import { centsToUsd, usdToCents } from "./usd.ts";
import { startOfDay } from "./value-history.ts";

type Fills = Parameters<typeof holdingsByThread>[1];

/** Cash that only waits to be spent: what no take holds, wherever it sits. */
const waiting = (holding: Holding) => holding.cash && !holding.heldForOrders;

/**
 * What every take holds, by the fills Auni recorded in it (see holdingsByThread), and the rest:
 * each holding that isn't cash, and savings, which a take can buy ("Keep my idle cash earning"
 * puts it into savings). The thread inspector, the agent's context and GET /takes all read this,
 * so they give a take the same holdings, worth and gain.
 */
export function heldByTakes(
  portfolio: Pick<Portfolio, "assets" | "cash">,
  everyFill: Fills,
): ReturnType<typeof holdingsByThread> {
  const savings = portfolio.cash.holdings.filter((holding) => isSavings(holding.venue));
  return holdingsByThread([...portfolio.assets.holdings, ...savings], everyFill);
}

/**
 * The owner's takes: each thread that holds something now, by the fills Auni recorded in it,
 * with what it holds, what that is worth and what it has made; what no take holds; and the cash
 * no take holds, by where it is.
 */
export async function readTakes(): Promise<z.input<typeof takesWireSchema>> {
  const [portfolio, everyFill, { timeZone }] = await Promise.all([
    portfolioNow(),
    allFills(db),
    theOwner(),
  ]);
  const split = heldByTakes(portfolio, everyFill);
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
    loose: await holdingViews(
      split.loose.filter((holding) => !waiting(holding)),
      today,
    ),
    cash: cashPlaces([
      ...portfolio.cash.holdings.filter((holding) => !isSavings(holding.venue)),
      ...split.loose.filter(waiting),
    ]),
  };
}

/**
 * Cash by where it is: the owner's own wallets first, always, which Withdraw sends from, then
 * each app that keeps some, largest first, as Withdraw names them.
 */
function cashPlaces(cash: readonly Holding[]): z.input<typeof takesWireSchema>["cash"] {
  const byVenue = Map.groupBy(cash, ({ venue }) => venue);
  const apps = [...byVenue]
    .filter(([venue]) => venue !== "wallet")
    .map(([venue, held]) => ({
      venue,
      name: appListing(venue)?.name ?? venue,
      logoUrl: appListing(venue)?.logo ?? null,
      savings: isSavings(venue),
      usdValue: worthUsd(held),
    }))
    .filter(({ usdValue }) => usdToCents(usdValue) > 0n)
    .toSorted((a, b) => Number(usdToCents(b.usdValue) - usdToCents(a.usdValue)));
  return [
    {
      venue: "wallet",
      name: "Your wallet",
      logoUrl: null,
      savings: false,
      usdValue: worthUsd(byVenue.get("wallet") ?? []),
    },
    ...apps,
  ];
}

/**
 * What a take's holdings have made since they were bought, over what they cost, counting only
 * the ones whose cost is known (see gainOf); null for both when none is.
 */
export function takeChange(held: readonly Holding[]): {
  changeUsd: string | null;
  costUsd: string | null;
} {
  const known = held.flatMap((holding) => gainOf(holding) ?? []);
  if (known.length === 0) return { changeUsd: null, costUsd: null };
  const sum = (part: "costCents" | "changeCents") =>
    centsToUsd(known.reduce((total, gain) => total + gain[part], 0n));
  return { changeUsd: sum("changeCents"), costUsd: sum("costCents") };
}
