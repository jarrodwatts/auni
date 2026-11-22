import { type DepositWire, type NetworkKey } from "@auni/shared";
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import { lockOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { actions, arrivals, type ActionRow } from "../db/schema.ts";
import { nameOf, showPosted, tellArrivals } from "./news.ts";
import { told, TOLD_SQL } from "./told.ts";
import { savingsTokens } from "../apps/registry.ts";
import { chainName } from "./chains.ts";
import { isPlainCash } from "./coins.ts";
import { notOther, tokenName } from "./buckets.ts";
import { feeCoinPaidBy } from "./fee-coin.ts";
import { fillIdentity, solanaMintKey, tokenKey } from "./fill-key.ts";
import { pricesAt, walletPriceKey } from "./history.ts";
import { startCounting } from "./other-tokens.ts";
import { readFrom } from "./portfolio.ts";
import { askForReading, STUCK_AFTER_MS } from "./readings.ts";
import { deciding } from "./reconcile.ts";
import { LANDING_WINDOW_MS } from "./record.ts";
import { recipeForTool } from "./recipes/index.ts";
import { readTransfers, solanaSignatures, type TokenAccount, type Transfer } from "./transfers.ts";
import { formatUnits, unitsUsd } from "./usd.ts";
import { walletAddresses } from "./wallets.ts";

/**
 * Money moving into or out of the wallets. A sweep is only a hint that
 * a transaction may have touched them: the recorder reads that transaction
 * from the chain, never the hint's word for what it did, and tells each
 * transfer apart once, by Auni's own records first:
 *
 *   own_move      a transaction one of their actions sent
 *   landing       what a move of theirs sent on, delivered by someone else
 *   payout        a savings venue giving back savings
 *   external_out  money leaving that Auni didn't send
 *   deposit       anything else coming in
 *
 * What is held is still read live; these say only what moved, and when.
 */
export type ArrivalKind = "own_move" | "landing" | "payout" | "external_out" | "deposit";

type ArrivalRow = typeof arrivals.$inferSelect;

/**
 * Thrown while Auni's own records can't yet say what a transaction is, as
 * they will once a running move records it or is past its time (see awaited), so
 * whoever hinted tries again, and a sweep doesn't pass it (see sweepNetwork).
 */
export class NotKnownYet extends Error {}

/**
 * Records what one transaction moved into or out of the wallet on
 * `chain`, each transfer once however often it is hinted, and tells them
 * what is worth telling (see tellArrivals); then asks for a reading. Only a
 * token that is theirs or that Auni recognises is recorded (see buckets.ts):
 * an Other one that came in is noted as seen, and costs nothing more. Throws
 * when the chain or a price can't be read yet, so whoever hinted tries
 * again. What a token account it closed received is recorded first (see
 * recordClosed).
 */
export async function recordArrivals(chain: NetworkKey, hint: string): Promise<void> {
  const wallets = await walletAddresses();
  const wallet = chain === "solana" ? wallets.solana : wallets.evm;
  if (!wallet) return;
  // An EVM hash is hex, which a hint may write in either case; a Solana signature's case is its own.
  const txHash = chain === "solana" ? hint : hint.toLowerCase();
  const {
    at,
    block,
    transfers: moved,
    walletSigned,
    closedAccounts,
  } = await readTransfers(chain, txHash, wallet);
  await recordClosed(txHash, closedAccounts);
  if (moved.length === 0) return;
  const { counted: transfers, sorted } = await notOther(chain, moved, {
    instrument: (transfer) => transfer.instrument,
    cameIn: (transfer) => transfer.baseUnits > 0n,
  });
  if (transfers.length === 0) return;
  const [sentBy, unnamed, delivering, prices, read] = await Promise.all([
    actionThatSent(txHash).then((sent) => sent ?? boughtForFees(chain, txHash, transfers)),
    sendingUnnamed(chain, walletSigned || transfers.some((transfer) => transfer.baseUnits < 0n)),
    movesDelivering(txHash, at),
    pricesAt(
      transfers.flatMap((transfer) => walletPriceKey(chain, transfer.instrument) ?? []),
      at,
    ),
    readFrom(
      chain,
      at,
      transfers.map((transfer) => transfer.instrument),
    ),
  ]);
  // Told apart as someone else's, Auni's own buy would count as money put in twice.
  if (!sentBy && unnamed) throw new NotKnownYet(`${txHash} may be a send of Auni's not named yet.`);
  const rows = transfers.map((transfer) => ({
    chain,
    txHash,
    position: transfer.position,
    instrument: transfer.instrument,
    baseUnits: String(transfer.baseUnits),
    decimals: transfer.decimals,
    usdValue: valueOf(chain, transfer, prices),
    symbol: tokenName(
      { chain, instrument: transfer.instrument },
      sorted.get(fillIdentity({ chain, instrument: transfer.instrument })),
      transfer.symbol,
    ),
    counterparty: transfer.counterparty,
    at,
    block,
    // From the first reading that held it (see readFrom), lest those before count it as
    // made or lost; for a token Auni doesn't read yet, the default: now, as it is recorded.
    countsFrom: read.get(fillIdentity({ chain, instrument: transfer.instrument })),
    ...classify(chain, txHash, transfer, sentBy, delivering, at),
  }));
  // A token money from outside moves begins to count here if it doesn't yet, whatever a list
  // says of it later, at what the wallet holds of it then: that holds this transfer or not by
  // its block, so it counts once either way (see startCounting). Auni's own moves count by
  // their fills.
  await startCounting(
    chain,
    rows.flatMap(({ kind, instrument }) =>
      kind === "deposit" || kind === "external_out" ? [instrument] : [],
    ),
  );
  const posted = await db.transaction(async (tx) => {
    // The owner's row first, as landLate and startCounting take it, so recordings take turns.
    await lockOwner(tx);
    const inserted = await tx.insert(arrivals).values(rows).onConflictDoNothing().returning();
    // A finished action asks for its own (see finish), as will one whose hash the wallet's
    // signature got ahead of.
    if (inserted.some((row) => row.kind !== "own_move" && !row.actionId && told(row)))
      await askForReading(tx);
    return tellArrivals(tx, inserted);
  });
  await showPosted(posted);
}

/**
 * Records first what each Solana token account this transaction closed, of
 * a token that isn't Other (see buckets.ts), took part in before it: a
 * deposit into an account names only the account, and a sweep lists only
 * accounts that exist (see solanaTxs), so once closed nothing else would
 * read it, and a sweep's cursor may be past it already. It reads back the
 * pages a sweep lists, so a flood sent into the account costs no more; older
 * than those, a sweep read while the account was open, unless that flood
 * came between two. Throws while one can't be recorded, so neither is this,
 * and whoever hinted tries again.
 */
async function recordClosed(txHash: string, closed: readonly TokenAccount[]): Promise<void> {
  if (closed.length === 0) return;
  const { counted } = await notOther("solana", closed, {
    instrument: ({ mint }) => solanaMintKey(mint).instrument,
    cameIn: () => false,
  });
  for (const { address } of counted) {
    const { signatures } = await solanaSignatures(address, 0, txHash);
    const earlier = await unrecorded("solana", signatures);
    for (const { hash } of earlier.toSorted((a, b) => a.block - b.block))
      await recordArrivals("solana", hash);
  }
}

/** The transactions none of whose transfers is recorded yet. */
export async function unrecorded<T extends { readonly hash: string }>(
  chain: string,
  txs: readonly T[],
): Promise<T[]> {
  if (txs.length === 0) return [];
  const recorded = await db
    .selectDistinct({ txHash: arrivals.txHash })
    .from(arrivals)
    .where(
      and(
        eq(arrivals.chain, chain),
        inArray(
          arrivals.txHash,
          txs.map((tx) => tx.hash),
        ),
      ),
    );
  const seen = new Set(recorded.map((row) => row.txHash));
  return txs.filter((tx) => !seen.has(tx.hash));
}

/** The action of theirs that sent this transaction, by the hashes it kept. */
async function actionThatSent(txHash: string): Promise<string | null> {
  const [action] = await db
    .select({ id: actions.id })
    .from(actions)
    .where(
      sql`exists (select 1 from jsonb_array_elements(${actions.txs}) sent where lower(sent->>'hash') = lower(${txHash}))`,
    )
    .limit(1);
  return action?.id ?? null;
}

/**
 * The move this transaction pays the chain's coin to, bought on its card for its fees
 * (fee-coin.ts): the pay-in service sends it, so no send of the move's own names it. Asked only
 * of the chain's coin coming in. It is that move's own, never money the owner put in, so it is
 * told nowhere and counts as nothing made or lost. Throws NotKnownYet while a purchase waits to
 * be paid there and the service can't yet say which transaction pays it.
 */
async function boughtForFees(
  chain: NetworkKey,
  txHash: string,
  transfers: readonly Pick<Transfer, "instrument" | "baseUnits">[],
): Promise<string | null> {
  if (!transfers.some((moved) => moved.instrument === "native" && moved.baseUnits > 0n))
    return null;
  const paid = await feeCoinPaidBy(chain, txHash);
  if (paid === "unknown")
    throw new NotKnownYet(`${txHash} may be the coin a move bought for its fees, not named yet.`);
  return paid;
}

/**
 * Whether a move of theirs, running and not stuck, sent on `chain` a
 * transaction whose hash hasn't come back yet, as its receipts would be
 * read (see deciding): any transaction may be that one until it does. One
 * the wallet acted in, by sending it or by money leaving it, may be any
 * move's still sending, kept or not: a Solana send keeps no placeholder
 * before the wallet returns its hash, and money leaves on what the wallet signed
 * but someone else sends (a sponsor's sends, a venue's relayer). A
 * move that is landing has sent all it will, and one stopped (unsure) has
 * kept what it may have sent (see markStopped), as the first rule reads.
 * With none still sending, the wallet acted outside Auni, and it counts as
 * anyone's.
 */
async function sendingUnnamed(chain: NetworkKey, walletActed: boolean): Promise<boolean> {
  const running = await db
    .select({
      phase: actions.phase,
      txs: actions.txs,
    })
    .from(actions)
    .where(
      and(
        eq(actions.status, "running"),
        gte(actions.startedAt, new Date(Date.now() - STUCK_AFTER_MS)),
      ),
    );
  const sending = running.some((action) => action.phase === "sending");
  if (walletActed && sending) return true;
  return running.some(({ txs }) => deciding(txs).some((tx) => tx.chain === chain && !tx.hash));
}

/**
 * Their moves that delivered this transaction, or may have: one that recorded
 * it as what delivered it, one that recorded the exact amount it delivers and
 * began no longer than STUCK_AFTER_MS before, and one still running that
 * began before it within the landing window, which may not have recorded
 * either yet (see awaited).
 */
function movesDelivering(txHash: string, at: Date) {
  const began = and(
    lte(actions.startedAt, at),
    gte(actions.startedAt, new Date(at.getTime() - STUCK_AFTER_MS)),
  );
  return db
    .select({
      id: actions.id,
      tool: actions.tool,
      input: actions.input,
      details: actions.details,
      run: actions.run,
      phase: actions.phase,
      startedAt: actions.startedAt,
      txs: actions.txs,
    })
    .from(actions)
    .where(
      or(
        sql`lower(${actions.run}->>'delivered') = lower(${txHash})`,
        and(sql`${actions.run} ? 'landsUnits'`, began),
        and(
          eq(actions.status, "running"),
          lte(actions.startedAt, at),
          gte(actions.startedAt, new Date(Date.now() - LANDING_WINDOW_MS)),
        ),
      ),
    );
}

type Delivering = Awaited<ReturnType<typeof movesDelivering>>[number];

/**
 * What a transfer is, by Auni's own records first: see ArrivalKind. A
 * landing is known only by what its move recorded delivering it; while a
 * move that delivers this hasn't recorded that yet, it throws NotKnownYet.
 */
function classify(
  chain: NetworkKey,
  txHash: string,
  transfer: Pick<Transfer, "instrument" | "baseUnits" | "counterparty">,
  sentBy: string | null,
  delivering: readonly Delivering[],
  at: Date,
): { kind: ArrivalKind; actionId: string | null } {
  if (sentBy) return { kind: "own_move", actionId: sentBy };
  if (transfer.baseUnits < 0n) return { kind: "external_out", actionId: null };
  const landing = delivering.find(
    (action) =>
      action.run.delivered?.toLowerCase() === txHash.toLowerCase() ||
      (action.run.landsUnits === String(transfer.baseUnits) &&
        lands(action, chain, transfer.instrument)),
  );
  if (landing) return { kind: "landing", actionId: landing.id };
  if (
    delivering.some(
      (action) =>
        awaited(action, at) &&
        (lands(action, chain, transfer.instrument) || givesBack(action, chain)),
    )
  )
    throw new NotKnownYet(`${txHash} may be what a move of theirs delivers, not recorded yet.`);
  if (transfer.counterparty && payers(chain).has(transfer.counterparty.toLowerCase()))
    return { kind: "payout", actionId: null };
  return { kind: "deposit", actionId: null };
}

/**
 * Whether a move may yet record that it delivered what arrived at `at`:
 * running, begun by then, with nothing recorded so far, and not stuck: a move
 * on its way is watched for its landing window (see settleLanding), any other
 * for STUCK_AFTER_MS. One that never records (a swap Auni sends itself, or a
 * move past its time) holds nothing up once it is done or past it.
 */
function awaited(action: Delivering, at: Date): boolean {
  const { startedAt, run } = action;
  const watchedMs = action.phase === "landing" ? LANDING_WINDOW_MS : STUCK_AFTER_MS;
  return (
    action.phase !== null &&
    startedAt !== null &&
    startedAt <= at &&
    startedAt.getTime() > Date.now() - watchedMs &&
    run.delivered === undefined &&
    run.landsUnits === undefined
  );
}

/**
 * Whether what arrived may be a move on its way given back on a chain it sent
 * from, as a bridge no one fills is refunded: which token comes back is the
 * venue's (what was sent, or what it was swapped into), so anything there may be.
 */
function givesBack(action: Delivering, chain: NetworkKey): boolean {
  return action.phase === "landing" && action.txs.some((tx) => tx.chain === chain && !tx.setup);
}

/**
 * Whether what arrived is what this move delivers, as known before anything
 * was sent: the USDC a move sending cash on readies, the cash a sale brings
 * back, or the token any other trade gets. Never what a sale lets go of.
 */
function lands(
  action: Pick<ActionRow, "tool" | "input" | "details">,
  chain: NetworkKey,
  instrument: string,
): boolean {
  const recipe = recipeForTool(action.tool);
  const input = action.input as never;
  const readied = recipe?.readies?.(input);
  if (readied) return readied === chain && isPlainCash(chain, instrument);
  // A trade's details name the token it trades: what a sale sells, what anything else gets.
  const { chain: on, mint } = action.details;
  if (on !== chain || mint === undefined) return false;
  if (recipe?.direction?.(input) === "sell") return isPlainCash(chain, instrument);
  return fillIdentity({ chain, instrument }) === fillIdentity(tokenKey(chain, mint));
}

/** Who pays out rather than deposits: where savings are kept, handing them back. */
function payers(chain: NetworkKey): Set<string> {
  return new Set(
    savingsTokens(chain).flatMap(({ pool, token }) => [pool.toLowerCase(), token.toLowerCase()]),
  );
}

/** Its dollars when it moved, signed as it moved; null for a token with no price. */
function valueOf(
  chain: NetworkKey,
  transfer: Transfer,
  prices: ReadonlyMap<string, number>,
): string | null {
  const key = walletPriceKey(chain, transfer.instrument);
  const price = key === null ? 1 : prices.get(key);
  if (price === undefined) return null;
  return unitsUsd(transfer.pricedUnits ?? transfer.baseUnits, transfer.decimals, price);
}

/** Long enough that a deposit recorded while a screen waits on one is still there to see. */
const RECENT_MS = 60 * 60_000;

/**
 * The latest few deposits told (see toldDeposit), recorded in the last hour,
 * newest first: what a screen waiting on a deposit sees land. Recorded, not
 * made, as a first sweep may find money sent in days ago, which is news all the same.
 */
export async function recentDeposits(): Promise<ArrivalRow[]> {
  return db
    .select()
    .from(arrivals)
    .where(
      and(
        eq(arrivals.kind, "deposit"),
        gte(arrivals.createdAt, new Date(Date.now() - RECENT_MS)),
        TOLD_SQL,
      ),
    )
    .orderBy(desc(arrivals.createdAt), asc(arrivals.position))
    .limit(5);
}

/** A deposit as a person reads it: "0.081 ETH on Base", its token named as news names it (see nameOf). */
export function depositWire(row: ArrivalRow): DepositWire {
  return {
    id: row.id,
    symbol: nameOf(row),
    amount: formatUnits(BigInt(row.baseUnits), row.decimals),
    network: chainName(row.chain as NetworkKey),
    usdValue: row.usdValue ?? "0.00",
  };
}
