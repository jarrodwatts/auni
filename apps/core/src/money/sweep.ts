import {
  DEPOSIT_WAIT_MS,
  EVM_CHAIN_KEYS,
  isCash,
  type EvmChainKey,
  type NetworkKey,
} from "@auni/shared";
import type { Address } from "viem";
import { eq, gt, isNotNull, sql } from "drizzle-orm";

import { attempt } from "../app-troubles.ts";
import { db } from "../db/client.ts";
import { arrivalCursors, arrivals, fills, threads, otherTokens } from "../db/schema.ts";
import { NotKnownYet, recordArrivals, unrecorded } from "./arrivals.ts";
import { notOther } from "./buckets.ts";
import { publicClient, solanaRpc, SPL_TOKEN_PROGRAMS } from "./chains.ts";
import { coinDeposits, logSpan, transferLogs, type TransferLog } from "./evm-history.ts";
import { solanaMintKey } from "./fill-key.ts";
import { lookedAt, markLooked, placeOf, stillLooking } from "./first-look.ts";
import { countWhatWasThere, tellRecognised } from "./other-tokens.ts";
import { payoutSweeps } from "./payouts.ts";
import { statementSweeps } from "./statements.ts";
import { solanaSignatures } from "./transfers.ts";
import { hasWallet, walletAddresses } from "./wallets.ts";
import { errorWords } from "../safe-words.ts";

/**
 * The sweep: every transaction that moved money into or out of the
 * wallets since the last sweep, each handed to the recorder as a hint. It
 * reads the chain itself, through Auni's RPC for each network (see rpcFor),
 * as a reading is taken, as the app opens, and every minute or so while a
 * deposit is awaited (see sweepJob). Each network keeps the block
 * through which every transaction has been read: what one moved, if
 * anything, is the recorder's to keep.
 */

/**
 * The latest blocks, or Solana slots, each sweep reads again: minutes on
 * every network, past what a chain may still reorder or an RPC behind the
 * others has yet to serve. The recorder keys each transfer, so this records
 * nothing twice, and a transaction that can't be read yet is tried again
 * while it's among them.
 */
const OVERLAP = 1_000;

/**
 * Sweeps the networks the owner has a wallet on, and records what each
 * prediction market paid out, which no network's sweep reads (see
 * payoutSweeps), and what each perps venue's statement says traded, when it
 * is due a read (see statementSweeps), and tells them of any token
 * they were sent that Auni has come to recognise (see tellRecognised); one
 * that can't be read now is reported and swept next time. Where Auni spends
 * cash is always swept, any other EVM network once money has been there,
 * and `everywhere` every one, while a deposit is expected.
 */
export async function sweepArrivals(everywhere = false): Promise<void> {
  const [wallets, visited, looking] = await Promise.all([
    walletAddresses(),
    everywhere ? null : visitedChains(),
    walletAddresses().then(stillLooking),
  ]);
  const { evm, solana } = wallets;
  // Every network until its first look is made, so what the wallet held there before is found.
  const swept = EVM_CHAIN_KEYS.filter(
    (chain) => !visited || isCash(chain) || visited.has(chain) || looking.includes(chain),
  );
  const sweeps: { name: string; run: () => Promise<void> }[] = [
    ...(evm ? swept.map((chain) => ({ name: chain, run: () => sweepNetwork(chain, evm) })) : []),
    ...(solana ? [{ name: "solana", run: () => sweepNetwork("solana", solana) }] : []),
    // An app's own read that fails is noted on its sheet and in doctor until it reads again,
    // which says it in the log once, not every sweep.
    ...(evm ? [...payoutSweeps(evm), ...statementSweeps(async () => evm)] : []).map(
      ({ app, work, run }) => ({
        name: `${app.name} ${work}`,
        run: () => attempt(app, work, run).catch(() => undefined),
      }),
    ),
    // Lists grow, so a token they were sent that Auni didn't know may be one it knows now.
    { name: "recognised tokens", run: () => tellRecognised() },
  ];
  const results = await Promise.allSettled(sweeps.map(({ run }) => run()));
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const { name } = sweeps[index]!;
    // A sweep that keeps failing would hide money that moved.
    console.error(`arrivals sweep of ${name} failed: ${errorWords(result.reason).split("\n")[0]}`);
  });
}

/** An app's own read in the sweep: what its account paid out, or its statement (payoutSweeps, statementSweeps). */
export interface AppSweep {
  readonly app: { readonly id: string; readonly name: string };
  /** The work, as a trouble names it: "reading payouts". */
  readonly work: string;
  run(): Promise<void>;
}

/**
 * The networks the wallet has had money on, by readPortfolio's rule for which
 * chains it reads: a fill there, an arrival of something theirs or that Auni
 * recognises (no other is recorded), or a token counted since (see
 * startCounting).
 */
async function visitedChains(): Promise<Set<string>> {
  const [arrived, filled, kept] = await Promise.all([
    db.selectDistinct({ chain: arrivals.chain }).from(arrivals).where(gt(arrivals.baseUnits, "0")),
    db.selectDistinct({ chain: fills.chain }).from(fills),
    db
      .selectDistinct({ chain: otherTokens.chain })
      .from(otherTokens)
      .where(isNotNull(otherTokens.keptAt)),
  ]);
  return new Set([...arrived, ...filled, ...kept].map(({ chain }) => chain));
}

/**
 * Sweeps one network on from its cursor. A wallet never swept is read over
 * its whole history on Solana, which is its first look (see first-look.ts),
 * and from its latest OVERLAP blocks on an EVM network, whose history no plain
 * RPC lists: Auni's first look there, once, counts what it held before then
 * that Auni recognises (see countWhatWasThere). A transaction that can't be read holds
 * nothing back: while it's among the latest OVERLAP blocks it is read again
 * next sweep, and once older it is reported and passed, so one built to fail
 * can't stop the sweep. One Auni's own records can't tell yet is read again
 * until they can. Neither is a failure of the sweep, so only what stops the
 * sweep throws.
 */
export async function sweepNetwork(chain: NetworkKey, wallet: string): Promise<void> {
  const [cursor] = await db
    .select({ block: arrivalCursors.block, resume: arrivalCursors.resume })
    .from(arrivalCursors)
    .where(eq(arrivalCursors.chain, chain));
  const from = cursor ? cursor.block + 1 : 0;
  const place = placeOf("wallet", chain);
  if (chain !== "solana" && (await lookedAt([place])).size === 0) {
    await countWhatWasThere(chain, wallet as Address);
    await markLooked([place]);
  }
  const { head, listedTo, txs, resume } =
    chain === "solana"
      ? await solanaTxs(wallet, from, cursor?.resume ?? {})
      : await evmTxs(chain, wallet, cursor ? from : null);
  const pending = (await unrecorded(chain, txs)).toSorted((a, b) => a.block - b.block);
  // The rest of the last one's block too, so the cursor can pass it.
  const last = pending[PER_SWEEP - 1]?.block;
  const batch = last === undefined ? pending : pending.filter((tx) => tx.block <= last);
  const settled = head - OVERLAP;
  // The first block holding one Auni's records can't tell yet: they will before long.
  let held = Infinity;
  for (const { hash, block } of batch) {
    try {
      await recordArrivals(chain, hash);
    } catch (error) {
      if (error instanceof NotKnownYet) held = Math.min(held, block);
      if (block > settled || error instanceof NotKnownYet)
        console.warn(`${chain} sweep reads ${hash} again next time:`, error);
      else console.error(`${chain} sweep passes ${hash}, which can't be read:`, error);
    }
  }
  // As far as this sweep got, short of the blocks read again and any held; never back.
  const through = Math.max(
    from - 1,
    Math.min(batch.length < pending.length ? last! : listedTo, settled, held - 1),
  );
  await db
    .insert(arrivalCursors)
    .values({ chain, block: through, resume })
    .onConflictDoUpdate({
      target: arrivalCursors.chain,
      // Two sweeps at once never move it back. Either's resume is safe, as it only stops short.
      set: { block: sql`greatest(${arrivalCursors.block}, ${through})`, resume },
    });
  if (chain === "solana") await markLooked([place]);
}

/**
 * Transactions one sweep records at most, oldest first, so a wallet's first
 * sweep over a long history is worked through a sweep at a time.
 */
const PER_SWEEP = 50;

interface ListedTx {
  readonly hash: string;
  /** Its block, or Solana slot. */
  readonly block: number;
}

interface Listed {
  /** The block or slot read before listing. */
  readonly head: number;
  /** Through which every transaction is listed: the head, unless a flood waits for the next sweep. */
  readonly listedTo: number;
  readonly txs: readonly ListedTx[];
  /** Where each Solana address's listing goes on from next sweep (see solanaTxs). */
  readonly resume?: Record<string, ListedTx>;
}

/**
 * How long one sweep reads a network's logs, so a wallet long unswept catches up a sweep at a
 * time. A time, not a count of spans, so a sweep keeps up with the chain however few blocks its
 * RPC serves a call (Monad makes about 3,000 blocks between two sweeps).
 */
const READ_LOGS_FOR_MS = 30_000;

/**
 * Every transaction that moved a token into or out of the wallet, from its
 * Transfer logs, or sent the chain's own coin straight to it (see
 * coinDeposits), from `from` (null: the latest OVERLAP blocks) to the head,
 * read first, a span at a time for READ_LOGS_FOR_MS. A span that fails
 * after others were read ends the listing there, so what was read counts,
 * and the next sweep starts with it; so does one no log RPC has reached yet
 * (see transferLogs), so the cursor never passes blocks nothing has read. Only coin and tokens that aren't Other
 * are kept (see buckets.ts), an Other one that came in noted as seen. Coin the wallet
 * sends shows here only beside a token, as in a swap; Auni's own sends are
 * recorded as they run.
 */
async function evmTxs(chain: EvmChainKey, wallet: string, from: number | null): Promise<Listed> {
  const head = Number(await publicClient(chain).getBlockNumber());
  const start = from ?? Math.max(head - OVERLAP, 0);
  const into: TransferLog[] = [];
  const out: TransferLog[] = [];
  const until = Date.now() + READ_LOGS_FOR_MS;
  let end = start - 1;
  while (end < head && (end < start || Date.now() < until)) {
    const to = Math.min(head, end + logSpan(chain));
    try {
      const [spanIn, spanOut] = await Promise.all([
        transferLogs(chain, wallet, "in", end + 1, to),
        transferLogs(chain, wallet, "out", end + 1, to),
      ]);
      into.push(...spanIn.logs);
      out.push(...spanOut.logs);
      end = Math.min(spanIn.through, spanOut.through);
    } catch (error) {
      if (end < start) throw error;
      console.warn(`${chain} sweep reads on from block ${end + 1} next time:`, error);
      break;
    }
    // No RPC has reached the rest of the span yet, so it is read next time, not passed as empty.
    if (end < to) break;
  }
  const coin =
    end < start
      ? { txs: [], through: end }
      : await coinDeposits(chain, wallet, start, end, PER_SWEEP);
  const listed = [
    ...into.map(({ hash, block, token }) => ({ hash, block, instrument: token, in: true })),
    ...out.map(({ hash, block, token }) => ({ hash, block, instrument: token, in: false })),
    ...coin.txs.map(({ hash, block }) => ({ hash, block, instrument: "native", in: true })),
  ];
  // Anyone can send a token they mint, so an Other one would otherwise cost a read.
  const { counted } = await notOther(chain, listed, {
    instrument: ({ instrument }) => instrument,
    cameIn: (transfer) => transfer.in,
  });
  const listedTo = coin.through;
  const txs = new Map<string, number>();
  for (const { hash, block } of counted) if (block <= listedTo) txs.set(hash, block);
  return { head, listedTo, txs: [...txs].map(([hash, block]) => ({ hash, block })) };
}

/**
 * Every transaction since slot `from` that touched the wallet or one of its
 * token accounts worth sweeping. A token's arrival touches only the token
 * account once that exists; its first names the wallet too, as the sender
 * creates the account. One the account received before it closed is read
 * as the wallet's transaction that closed it is recorded (see recordClosed).
 *
 * Each address lists newest first, PAGES_PER_SWEEP pages a sweep, so one
 * flooded stops short of `from` with its oldest unread, and then nothing is
 * listed whole and the next sweep lists on before the oldest it read. Once
 * that reaches `from`, what is whole is what lies before where it went on
 * from, until the cursor gets there and the address lists from the head.
 */
async function solanaTxs(
  wallet: string,
  from: number,
  resume: Readonly<Record<string, ListedTx>>,
): Promise<Listed> {
  const [head, accounts] = await Promise.all([
    solanaRpc<number>("getSlot", [{ commitment: "confirmed" }]),
    countedTokenAccounts(wallet),
  ]);
  const signatures = new Map<string, number>();
  const resumeNext: Record<string, ListedTx> = {};
  let listedTo = head;
  for (const address of [wallet, ...accounts]) {
    // Once the cursor gets where it went on from, all before that is read.
    const kept = resume[address];
    const before = kept && kept.block > from ? kept : undefined;
    const listing = await solanaSignatures(address, from, before?.hash);
    for (const { hash, block } of listing.signatures) signatures.set(hash, block);
    const goOn = listing.resume ?? before;
    if (goOn) resumeNext[address] = goOn;
    listedTo = Math.min(listedTo, listing.resume ? from - 1 : before ? before.block - 1 : head);
  }
  return {
    head,
    listedTo,
    txs: [...signatures].flatMap(([hash, block]) => (block <= listedTo ? [{ hash, block }] : [])),
    resume: resumeNext,
  };
}

/**
 * The wallet's token accounts of what isn't Other (see buckets.ts): anyone
 * can make the wallet an account of a token they mint, so one of each spam
 * token would otherwise cost a listing. The mint of each other one that
 * holds something is noted as seen, however it came.
 */
async function countedTokenAccounts(wallet: string): Promise<string[]> {
  const programs = await Promise.all(
    SPL_TOKEN_PROGRAMS.map((programId) =>
      solanaRpc<{
        value: {
          pubkey: string;
          account: {
            data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } };
          };
        }[];
      }>("getTokenAccountsByOwner", [
        wallet,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]),
    ),
  );
  const { counted } = await notOther(
    "solana",
    programs.flatMap(({ value }) =>
      value.map(({ pubkey, account }) => ({ pubkey, ...account.data.parsed.info })),
    ),
    {
      instrument: ({ mint }) => solanaMintKey(mint).instrument,
      cameIn: ({ tokenAmount }) => BigInt(tokenAmount.amount) > 0n,
    },
  );
  return counted.map(({ pubkey }) => pubkey);
}

/** When Auni last swept the wallets, in milliseconds; 0 for not since it started. */
let lastSwept = 0;

/** As often as a reading is kept. */
const SWEEP_EVERY_MS = 15 * 60_000;
/** While a deposit is expected, as often as a screen waiting on one asks. */
const EXPECTING_EVERY_MS = 10_000;

/**
 * Whether the wallets are due a sweep: not swept within 15 minutes, or 10
 * seconds while a deposit is expected. True marks them swept now.
 */
export function sweepDue(expectingDeposit: boolean): boolean {
  const now = Date.now();
  const everyMs = expectingDeposit ? EXPECTING_EVERY_MS : SWEEP_EVERY_MS;
  if (now - lastSwept < everyMs) return false;
  lastSwept = now;
  return true;
}

/**
 * Sweeps the wallets when they're due (see sweepDue). Nothing before there is a wallet: a sweep
 * with nothing to read must not count, or the wallet made a moment later (as the owner sends
 * their first take) would wait a quarter hour for its first look, and the portfolio would say it
 * was still looking all that while.
 */
export async function sweepWhenDue(expectingDeposit: boolean): Promise<void> {
  if (!(await hasWallet())) return;
  if (sweepDue(expectingDeposit)) await sweepArrivals(expectingDeposit);
}

/** Sweeps the wallets in the background, when they're due (see sweepWhenDue). */
export function sweepSoon(expectingDeposit: boolean): void {
  void sweepWhenDue(expectingDeposit).catch((error: unknown) =>
    console.error("arrivals sweep failed", error),
  );
}

/** Whether a thread is waiting for a deposit (see DEPOSIT_WAIT_MS), which keeps the sweep quick. */
export async function awaitingDeposit(): Promise<boolean> {
  const [waiting] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(gt(threads.awaitingDepositSince, new Date(Date.now() - DEPOSIT_WAIT_MS)))
    .limit(1);
  return waiting !== undefined;
}
