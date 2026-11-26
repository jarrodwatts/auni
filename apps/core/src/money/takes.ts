import { appListing, type takesWireSchema } from "@auni/shared";
import { inArray } from "drizzle-orm";
import type { z } from "zod";

import { isSavings } from "../apps/registry.ts";
import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { threads } from "../db/schema.ts";
import { allFills, gainOf, holdingsByThread, worthUsd } from "./books.ts";
import type { DayFill } from "./day-moves.ts";
import { holdingId, holdingViews } from "./holdings.ts";
import { arrivalFlows } from "./made.ts";
import { portfolioNow, type Holding, type Portfolio } from "./portfolio.ts";
import { centsToUsd, usdToCents } from "./usd.ts";
import { startOfDay } from "./value-history.ts";

/** What the takes are read from: every fill, and the money that came in from outside Auni. */
export interface TakeRecords {
  readonly fills: Parameters<typeof holdingsByThread>[1];
  readonly sentIn: Parameters<typeof holdingsByThread>[3];
}

/** Reads what heldByTakes splits the portfolio by. */
export async function takeRecords(): Promise<TakeRecords> {
  const [fills, sentIn] = await Promise.all([allFills(db), arrivalFlows()]);
  return { fills, sentIn };
}

/** Cash that only waits to be spent: what no take holds, wherever it sits. */
const waiting = (holding: Holding) => holding.cash && !holding.heldForOrders;

/** What the portfolio comes to, as Money shows it (see heldByTakes). */
interface MoneySplit {
  /** What each take holds, by the fills Auni recorded in it. */
  readonly threads: Map<string, Holding[]>;
  /** What no take holds and isn't cash. */
  readonly loose: Holding[];
  /**
   * Cash: what no take holds and only waits to be spent, wherever it sits. Savings a take
   * bought are that take's ("Keep my idle cash earning"), never Cash.
   */
  readonly cash: Holding[];
  /** What Cash comes to, in dollars. */
  readonly cashUsd: string;
}

/**
 * What every take holds, by the fills Auni recorded in it (see holdingsByThread), what no take
 * holds, and Cash. Savings count as a holding a take can buy ("Keep my idle cash earning" puts
 * it into savings); savings no take bought are Cash. Money, the thread inspector, the agent's
 * context and its portfolio tool, new chat's starting points and Telegram's /money all read
 * this, so a take holds the same and Cash is the same figure everywhere.
 */
export function heldByTakes(
  portfolio: Pick<Portfolio, "assets" | "cash" | "observedAt">,
  records: TakeRecords,
): MoneySplit {
  const savings = portfolio.cash.holdings.filter((holding) => isSavings(holding.venue));
  const split = holdingsByThread(
    [...portfolio.assets.holdings, ...savings],
    records.fills,
    new Date(portfolio.observedAt),
    records.sentIn,
  );
  const cash = [
    ...portfolio.cash.holdings.filter((holding) => !isSavings(holding.venue)),
    ...split.loose.filter(waiting),
  ];
  return {
    threads: split.threads,
    loose: split.loose.filter((holding) => !waiting(holding)),
    cash,
    cashUsd: worthUsd(cash),
  };
}

/**
 * The owner's takes: each thread that holds something now, by the fills Auni recorded in it,
 * with what it holds, what that is worth and what it has made; what no take holds; and the cash
 * no take holds, by where it is. `read` is the portfolio to split, when the caller has one.
 */
export async function readTakes(
  read: Promise<Portfolio> = portfolioNow(),
): Promise<z.input<typeof takesWireSchema>> {
  const [portfolio, records, { timeZone }] = await Promise.all([read, takeRecords(), theOwner()]);
  const split = heldByTakes(portfolio, records);
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
  const byThread = Map.groupBy(records.fills, (fill) => fill.threadId);
  const takes = await Promise.all(
    [...split.threads].map(async ([threadId, held]) => ({
      threadId,
      title: titles.get(threadId) ?? "Untitled take",
      valueUsd: worthUsd(held),
      ...takeChange(held),
      holdings: await takeHoldings(held, today, byThread.get(threadId) ?? []),
    })),
  );
  return {
    // A take whose holdings are all crumbs too small to show holds nothing worth a row.
    takes: takes
      .filter((take) => take.holdings.length > 0)
      .toSorted((a, b) => Number(usdToCents(b.valueUsd) - usdToCents(a.valueUsd))),
    loose: await holdingViews(split.loose, today, byThread.get(null) ?? []),
    cash: cashPlaces(split.cash),
  };
}

/** A take's holdings as a person reads them, each with what it alone has made (see takeChange). */
async function takeHoldings(held: readonly Holding[], today: number, fills: readonly DayFill[]) {
  const byId = new Map(held.map((holding) => [holdingId(holding), holding]));
  return (await holdingViews(held, today, fills)).map((view) => {
    const holding = byId.get(view.id)!;
    return { ...view, ...takeChange([holding]), savings: isSavings(holding.venue) };
  });
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
