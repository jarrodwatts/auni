import { and, eq, gt, max, or, sql, type SQL } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import { actions, arrivals, firstLooks, otherTokens, valueSnapshots } from "../db/schema.ts";
import { readingKind } from "../jobs/kinds.ts";
import type { Executor } from "../jobs/queue.ts";
import { isSavings } from "../apps/registry.ts";
import { livePrices, priceKey } from "./history.ts";
import type { Holding, Portfolio, ReadingHolding } from "./portfolio.ts";
import { TOLD_SQL } from "./told.ts";

// Readings: when a read of the portfolio may still miss a move, when one is kept, and keeping it.

/**
 * How long a fresh read may still miss a move that just settled: a chain can
 * take a moment to show what a buy landed or a sale took.
 */
export const SETTLING_MS = 2 * 60_000;

/**
 * Asks for a reading of their portfolio: an action of theirs finished, or money arrived.
 * Debounced a minute past SETTLING_MS, so it is taken once the chain shows what was asked
 * about, and several asked for together take one.
 */
export function askForReading(executor: Executor): Promise<void> {
  return readingKind.enqueue(executor, {}, { key: "reading", debounceMs: SETTLING_MS + 60_000 });
}

/** Longer than any recipe runs, so an action running this long is not still being worked on. */
export const STUCK_AFTER_MS = 30 * 60_000;

/**
 * An action still running, or done since a read began at `readStartedAt` (milliseconds) or within
 * SETTLING_MS before: that read may not show it.
 */
export function stillSettling(readStartedAt: number): SQL {
  // A span, not a moment, so it is judged on the database's clock as updatedAt is written.
  const settlingMs = Date.now() - readStartedAt + SETTLING_MS;
  return or(
    eq(actions.status, "running"),
    and(
      eq(actions.status, "done"),
      sql`${actions.updatedAt} > now() - make_interval(secs => ${settlingMs / 1000})`,
    ),
  )!;
}

/**
 * How long a read missing a source stands: while a venue is down, every open
 * app's poll would otherwise read every venue again, a venue's rate
 * budget shared with placing orders, yet it comes back soon after the venue does.
 */
const PARTIAL_STANDS_MS = 2 * 60_000;

/**
 * Whether a read still says what is held: younger than a reading is kept for
 * (READING_EVERY_MS), or PARTIAL_STANDS_MS when a source is missing from it,
 * which it still says, and nothing that changes what is held has happened
 * since it began (see changedSince).
 */
export async function readStands(read: Portfolio): Promise<boolean> {
  const readAt = new Date(read.observedAt);
  const standsMs = read.unavailable.length === 0 ? READING_EVERY_MS : PARTIAL_STANDS_MS;
  return (
    Date.now() - readAt.getTime() < standsMs && !(await changedSince(db, settledBefore(readAt)))
  );
}

export function priceKeys(holdings: readonly Holding[]): string[] {
  return holdings.flatMap((holding) => priceKey(holding) ?? []);
}

/** A holding's price among `prices`, as a reading keeps it: absent when its feed didn't answer. */
function priceOf(prices: ReadonlyMap<string, number>, holding: Holding): { price?: number } {
  const key = priceKey(holding);
  const price = key === null ? undefined : prices.get(key);
  return price === undefined ? {} : { price };
}

/** A live read is kept as a reading at most this often, unless an action finished since the last. */
const READING_EVERY_MS = 15 * 60_000;

/**
 * Keeps a live read as a reading: the total's row, with what it held and its
 * plain cash. Only when one is due (see readingDue), and only a whole read: a
 * source that couldn't be read would show as a false dip. Readings are kept one
 * at a time, so two reads at once keep one. True when it was kept.
 */
export async function saveReading(portfolio: Portfolio): Promise<boolean> {
  if (portfolio.unavailable.length > 0 || portfolio.looking.length > 0) return false;
  const takenAt = new Date(portfolio.observedAt);
  // The prices the read was valued at, from the shared feeds it just used, so moves count from them.
  const prices = await livePrices(priceKeys(portfolio.holdings));
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('auni:reading'))`);
    if (!(await readingDue(tx, takenAt))) return false;
    await tx.insert(valueSnapshots).values({
      usdValue: portfolio.totalUsd,
      cashUsd: plainCashUsd(portfolio).toFixed(2),
      holdings: portfolio.holdings.map((holding): ReadingHolding => ({
        chain: holding.chain,
        instrument: holding.instrument,
        priceId: holding.priceId,
        quantity: holding.quantity,
        decimals: holding.decimals,
        usdValue: holding.usdValue,
        cash: holding.cash,
        ...(holding.short ? { short: true } : {}),
        ...priceOf(prices, holding),
      })),
      takenAt,
    });
    return true;
  });
}

/**
 * Whether a read begun at `readAt` should be kept as a reading: once no move
 * may still be missing from it (see changedSince), and the last reading is
 * 15 minutes older, or something has changed what is held since it in a way
 * no estimate from it could know.
 */
export async function readingDue(q: Pick<Tx, "select">, readAt: Date): Promise<boolean> {
  if (await changedSince(q, settledBefore(readAt))) return false;
  const [last] = await q.select({ takenAt: max(valueSnapshots.takenAt) }).from(valueSnapshots);
  if (!last?.takenAt || readAt.getTime() - last.takenAt.getTime() >= READING_EVERY_MS) return true;
  return changedSince(q, last.takenAt);
}

/** What a read begun at `readAt` is sure to show: what settled before then, less SETTLING_MS. */
function settledBefore(readAt: Date): Date {
  return new Date(readAt.getTime() - SETTLING_MS);
}

/**
 * Whether what is held may have changed since `since`: a move of theirs
 * running, or something finished since (see finishedSince). A running move is
 * moving money only once started, and only for STUCK_AFTER_MS: one running
 * longer is stuck, and may be left so for a person (see
 * reconcileStuckActions), so it changes nothing.
 */
async function changedSince(q: Pick<Tx, "select">, since: Date): Promise<boolean> {
  const [[moving], finished] = await Promise.all([
    q
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.status, "running"),
          gt(actions.startedAt, new Date(Date.now() - STUCK_AFTER_MS)),
        ),
      )
      .limit(1),
    finishedSince(q, since),
  ]);
  return moving !== undefined || finished;
}

/**
 * Whether what is held has changed since `since`: a move of theirs finished
 * since, money recorded moving into or out of their wallets since (see
 * arrivals.ts), a holding kept since, which a read before then left out or
 * would count as made, or a first look made since (see first-look.ts).
 */
async function finishedSince(q: Pick<Tx, "select">, since: Date): Promise<boolean> {
  const [[landed], [arrived], [counted], [looked]] = await Promise.all([
    q
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.status, "done"), gt(actions.updatedAt, since)))
      .limit(1),
    // Money recorded moving since, by when Auni recorded it: a read begun before then
    // may leave out a token only its arrival has Auni read. Only what is told changes
    // what they hold by a cent (see told.ts).
    q
      .select({ id: arrivals.id })
      .from(arrivals)
      .where(and(gt(arrivals.createdAt, since), TOLD_SQL))
      .limit(1),
    q
      .select({ instrument: otherTokens.instrument })
      .from(otherTokens)
      .where(gt(otherTokens.keptAt, since))
      .limit(1),
    q
      .select({ place: firstLooks.place })
      .from(firstLooks)
      .where(gt(firstLooks.lookedAt, since))
      .limit(1),
  ]);
  return [landed, arrived, counted, looked].some((row) => row !== undefined);
}

/**
 * Whether a read shows the money as it was before something changed it: a
 * move finished, or money moved, after the read began. However young, it is
 * not what a screen that reads again as a move lands should show.
 */
export function outdated(read: Portfolio): Promise<boolean> {
  return finishedSince(db, new Date(read.observedAt));
}

/** The portfolio's cash that never earns: all of its cash but savings, and what is on its way. */
export function plainCashUsd(portfolio: Portfolio): number {
  return portfolio.holdings.reduce(
    (sum, holding) =>
      holding.cash && !isSavings(holding.venue) ? sum + Number(holding.usdValue ?? 0) : sum,
    Number(portfolio.onTheWay.usdValue),
  );
}
