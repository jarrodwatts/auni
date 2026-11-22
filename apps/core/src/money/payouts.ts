import { appListing } from "@auni/shared";
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import type { Address } from "viem";

import { db, type Tx } from "../db/client.ts";
import { actions, fills } from "../db/schema.ts";
import type { Payout } from "../apps/contract.ts";
import type { AppSweep } from "./sweep.ts";
import { accountOwning, accounts } from "../apps/registry.ts";
import { fillIdentity, QUANTITY_DECIMALS, type FillChain, type FillKey } from "./fill-key.ts";
import { usdLabel } from "./format.ts";
import { allFills, holdersOf, signedQuantity, threadBooks } from "./books.ts";
import type { Fill } from "./recipe.ts";
import { begins } from "./life.ts";
import { showPosted, tellPayout, type Posted } from "./news.ts";
import { insertFills } from "./record.ts";
import { formatUnits } from "./usd.ts";

/**
 * An account may pay out by itself, with no move of Auni's, as a prediction market pays a
 * resolved market (see Account.payouts), or pays nothing for the shares it resolved against.
 * Each payout is recorded as a done move of the account's payout tool, with a sale of every
 * share Auni's fills still hold of the market at what it paid for them, so the books close at the
 * payout rather than holding shares that are gone or worth nothing for good.
 */

type EveryFill = Awaited<ReturnType<typeof allFills>>;

/**
 * Records what each account that pays out paid for the shares Auni's fills hold, for `owner`,
 * the owner's EVM wallet: each payout once, however often or concurrently it is read. Nothing is
 * asked of an account while the fills hold nothing of its own. Throws when one can't be read, for
 * the next sweep to try again.
 */
export function payoutSweeps(owner: string): readonly AppSweep[] {
  return accounts().flatMap(({ about, account }) => {
    const { payouts } = account;
    if (!payouts) return [];
    return [
      {
        app: about,
        work: "reading payouts",
        async run() {
          const open = openHoldings(await allFills(db), about.id);
          if (open.size === 0) return;
          const since = Math.min(...open.values());
          const recorded = await recordedHashes(db, payouts.tool);
          const paid = await payouts.read(owner as Address, new Set(open.keys()), since, recorded);
          for (const payout of paid)
            await recordPayout(payout, { id: about.id, name: about.name, tool: payouts.tool });
        },
      },
    ];
  });
}

/** What the fills still hold some of that the app's account owns, by fillIdentity, with when the first was bought. */
function openHoldings(everyFill: EveryFill, app: string): Map<string, number> {
  const held = new Map<string, { units: bigint; since: number }>();
  for (const fill of everyFill) {
    const owner = accountOwning({ chain: fill.chain as FillChain, instrument: fill.instrument });
    if (owner?.about.id !== app) continue;
    const key = fillIdentity(fill);
    const entry = held.get(key) ?? { units: 0n, since: fill.createdAt.getTime() };
    held.set(key, { ...entry, units: entry.units + signedQuantity(fill) });
  }
  return new Map(
    [...held].flatMap(([key, { units, since }]) => (units > 0n ? [[key, since]] : [])),
  );
}

/** The transactions of payouts already recorded under `tool`, lowercased. */
async function recordedHashes(q: Pick<Tx, "select">, tool: string): Promise<Set<string>> {
  const rows = await q.select({ txs: actions.txs }).from(actions).where(eq(actions.tool, tool));
  return new Set(rows.flatMap(({ txs }) => txs.flatMap((sent) => sent.hash?.toLowerCase() ?? [])));
}

/**
 * Writes one transaction's payouts, a done move per market with its sales, once: a venue's
 * payouts are written one at a time, and a transaction already recorded, or a market whose
 * shares the books no longer hold (a loss nobody redeems, read again), is passed by.
 */
async function recordPayout(
  { hash, chain, markets }: Payout,
  venue: { readonly id: string; readonly name: string; readonly tool: string },
): Promise<void> {
  const posted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`auni:payouts:${venue.id}`}))`);
    if (hash && (await recordedHashes(tx, venue.tool)).has(hash)) return [];
    const everyFill = await allFills(tx);
    const told: Posted[] = [];
    for (const market of markets) {
      const sales = market.shares.flatMap((share) => closingSales(everyFill, share));
      if (sales.length === 0) continue;
      const summary =
        market.paidMicros > 0n
          ? `${venue.name} paid out ${usdLabel(Number(formatUnits(market.paidMicros, 6)))} for "${market.question}"`
          : `Lost on "${market.question}"`;
      const [action] = await tx
        .insert(actions)
        .values({
          summary,
          amountUsd: "0",
          ...begins("done"),
          venue: venue.id,
          tool: venue.tool,
          input: {},
          txs: hash ? [{ chain, hash }] : [],
        })
        .returning({ id: actions.id });
      await insertFills(tx, action!.id, sales);
      // Told in the transaction that records it, so a payout read twice is told once.
      told.push(
        ...(await tellPayout(tx, {
          actionId: action!.id,
          title: summary,
          threadId: await boughtIn(
            tx,
            market.shares.map((share) => share.key),
          ),
          logoUrl: appListing(venue.id)?.logo ?? null,
          paid: sales,
        })),
      );
    }
    return told;
  });
  await showPosted(posted);
}

/** The chat of the latest move that bought any of these outcomes' shares, if one of Auni's did. */
async function boughtIn(tx: Tx, keys: readonly FillKey[]): Promise<string | null> {
  if (keys.length === 0) return null;
  const [bought] = await tx
    .select({ threadId: actions.threadId })
    .from(fills)
    .innerJoin(actions, eq(actions.id, fills.actionId))
    .where(
      and(
        eq(fills.side, "buy"),
        isNotNull(actions.threadId),
        or(
          ...keys.map((key) =>
            and(eq(fills.chain, key.chain), eq(fills.instrument, key.instrument)),
          ),
        ),
      ),
    )
    .orderBy(desc(fills.createdAt))
    .limit(1);
  return bought?.threadId ?? null;
}

/**
 * Sales closing every share of one outcome the fills hold, the wallet now holding none: each
 * specialist's and the loose rest. What they were paid is shared as the portfolio splits a
 * holding (see holdersOf), over the shares the venue really burned.
 */
function closingSales(
  everyFill: EveryFill,
  share: Payout["markets"][number]["shares"][number],
): (Fill & { readonly threadId: string | null })[] {
  const key = fillIdentity(share.key);
  const books = threadBooks(everyFill);
  const loose = everyFill
    .filter((fill) => fill.threadId === null && fillIdentity(fill) === key)
    .reduce((sum, fill) => sum + signedQuantity(fill), 0n);
  const { burned } = share;
  const holders = holdersOf(burned, books, key);
  const credited = new Map(holders.threads);
  const owners: [string | null, bigint, bigint][] = [
    ...[...books].map(([id, book]): [string, bigint, bigint] => [
      id,
      book.get(key) ?? 0n,
      credited.get(id) ?? 0n,
    ]),
    [null, loose, loose < holders.other ? loose : holders.other],
  ];
  return owners
    .filter(([, units]) => units > 0n)
    .map(([threadId, units, paidUnits]) => ({
      threadId,
      ...share.key,
      side: "sell",
      quantity: formatUnits(units, QUANTITY_DECIMALS),
      usdValue: formatUnits(burned > 0n ? (share.paidMicros * paidUnits) / burned : 0n, 6),
    }));
}
