import { coinToken, NETWORKS, type EvmChainKey, type NetworkKey } from "@auni/shared";
import { erc20Abi, parseAbi, toHex, type Address, type Hash, type Log } from "viem";

import { publicClient, rpcAnswered, solanaRpc } from "./chains.ts";
import { solanaMintKey } from "./fill-key.ts";
import { evmXStocks } from "./swaps/xstocks.ts";

/**
 * What one transaction moved into or out of one wallet, read from the chain
 * itself. A chain can't say what an address holds over time, only what each
 * transaction did, so this is the one place Auni learns that money moved.
 */

export interface Transfer {
  /** Where in the transaction: "log:2" or "call:3" on an EVM chain; on Solana the mint, or "native". */
  readonly position: string;
  /** As a fill names it: a token's address or mint, or "native". */
  readonly instrument: string;
  readonly decimals: number;
  /** Negative when it left the wallet. */
  readonly baseUnits: bigint;
  /** The base units its price counts, where they aren't what moved: an EVM xStock's shares (see XSTOCK_MULTIPLIER). */
  readonly pricedUnits?: bigint;
  /** Who was on the other side, as far as the chain says. */
  readonly counterparty: string | null;
  /** What an EVM token's contract calls it: its maker's word, shown only once it's theirs (see tokenName). */
  readonly symbol?: string;
}

interface ChainTransaction {
  /** When its block was made. */
  readonly at: Date;
  /** Its block, or Solana slot. */
  readonly block: number;
  /** None when it failed, which moves nothing. */
  readonly transfers: readonly Transfer[];
  /**
   * Whether the wallet signed it: Auni's own while a move of theirs is
   * running that hasn't kept its hash yet (see sendingUnnamed).
   */
  readonly walletSigned: boolean;
  /**
   * The wallet's token accounts it closed or handed to another owner, on
   * Solana: from then on only their own listing names what they received
   * (see recordClosed).
   */
  readonly closedAccounts: readonly TokenAccount[];
}

export interface TokenAccount {
  readonly address: string;
  readonly mint: string;
}

/** Reads one transaction; throws while the chain doesn't show it yet, so the hint is tried again. */
export function readTransfers(
  chain: NetworkKey,
  hash: string,
  wallet: string,
): Promise<ChainTransaction> {
  return chain === "solana" ? readSolana(hash, wallet) : readEvm(chain, hash as Hash, wallet);
}

/** ERC-20's Transfer(address,address,uint256). ERC-721 shares it but indexes a third topic, its token id. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** One call in a callTracer trace. */
export interface CallFrame {
  readonly type: string;
  readonly from: string;
  readonly to?: string;
  readonly value?: string;
  readonly error?: string;
  readonly calls?: readonly CallFrame[];
}

/** A move of the chain's own coin or of a token, before its decimals are known. */
interface Move extends Omit<Transfer, "decimals"> {
  /** The token's contract; null for the chain's own coin. */
  readonly token: string | null;
}

/**
 * Every move into or out of `wallet` an EVM transaction made: each ERC-20
 * Transfer log, and each call in its trace that carried the chain's own coin,
 * at any depth, so coin a contract sends shows as well as coin sent directly.
 * A call that reverted moved nothing, and neither did anything under it.
 */
export function evmMoves(
  chain: string,
  logs: readonly Pick<Log, "address" | "topics" | "data">[],
  trace: CallFrame,
  wallet: string,
): Move[] {
  const own = wallet.toLowerCase();
  const moves: Move[] = [];
  const add = (position: string, token: string | null, from: string, to: string, units: bigint) => {
    const sent = from.toLowerCase() === own;
    const received = to.toLowerCase() === own;
    if (units === 0n || sent === received) return;
    moves.push({
      position,
      token,
      instrument: token ?? "native",
      baseUnits: sent ? -units : units,
      counterparty: (sent ? to : from).toLowerCase(),
    });
  };
  // A log's place in its transaction, not its block's logIndex, which a reorg changes.
  for (const [place, log] of logs.entries()) {
    const [topic, from, to] = log.topics;
    if (topic !== TRANSFER_TOPIC || !from || !to || log.topics.length !== 3) continue;
    // The coin's own token face: its Transfer logs repeat moves the call trace already shows.
    if (log.address.toLowerCase() === coinToken(chain)) continue;
    if (log.data.length !== 66) continue;
    add(
      `log:${place}`,
      log.address.toLowerCase(),
      topicAddress(from),
      topicAddress(to),
      BigInt(log.data),
    );
  }
  let index = 0;
  const walk = (frame: CallFrame) => {
    const position = `call:${index++}`;
    if (frame.error) return;
    if (VALUE_CALLS.has(frame.type) && frame.to && frame.value)
      add(position, null, frame.from, frame.to, BigInt(frame.value));
    for (const call of frame.calls ?? []) walk(call);
  };
  walk(trace);
  return moves;
}

/** The calls that move coin; a delegate or static call repeats or carries none. */
const VALUE_CALLS = new Set(["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"]);

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

async function readEvm(chain: EvmChainKey, hash: Hash, wallet: string): Promise<ChainTransaction> {
  const client = publicClient(chain);
  const receipt = await client.getTransactionReceipt({ hash });
  const [block, trace] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    receipt.status === "success" ? callsOf(client, hash) : null,
  ]);
  const at = new Date(Number(block.timestamp) * 1_000);
  const number = Number(receipt.blockNumber);
  // One a sponsor pays for is sent by its relayer, so only the wallet's kept id names it (see sendingUnnamed).
  const walletSigned = receipt.from.toLowerCase() === wallet.toLowerCase();
  if (!trace) return { at, block: number, transfers: [], walletSigned, closedAccounts: [] };
  const moves = evmMoves(chain, receipt.logs, trace, wallet);
  const tokens = [...new Set(moves.flatMap((move) => move.token ?? []))];
  const [reads, multipliers] = await Promise.all([
    // A token whose decimals can't be read is no working token: what it "moved" is left out.
    client.multicall({
      contracts: tokens.flatMap((token) => [
        { address: token as Address, abi: erc20Abi, functionName: "decimals" } as const,
        { address: token as Address, abi: erc20Abi, functionName: "symbol" } as const,
      ]),
      allowFailure: true,
    }),
    xStockMultipliers(client, receipt.blockNumber, tokens),
  ]);
  const readOf = (index: number) => {
    const read = reads[index];
    return read?.status === "success" ? read.result : undefined;
  };
  const decimalsOf = new Map(tokens.map((token, index) => [token, readOf(index * 2)]));
  const symbolOf = new Map(tokens.map((token, index) => [token, readOf(index * 2 + 1)]));
  return {
    at,
    block: number,
    transfers: moves.flatMap(({ token, ...move }) => {
      const read = token === null ? NETWORKS[chain].coin.decimals : decimalsOf.get(token);
      if (read === undefined) return [];
      const multiplier = token === null ? undefined : multipliers.get(token);
      const symbol = token === null ? undefined : symbolOf.get(token);
      return [
        {
          ...move,
          decimals: Number(read),
          ...(symbol === undefined ? {} : { symbol: String(symbol) }),
          ...(multiplier === undefined
            ? {}
            : { pricedUnits: (move.baseUnits * 10n ** 18n) / multiplier }),
        },
      ];
    }),
    walletSigned,
    closedAccounts: [],
  };
}

/**
 * The calls a transaction made, as its callTracer trace has them. Most public RPCs serve no
 * traces, and those that do may be too busy to, so any RPC's error makes it the transaction's
 * own top-level call alone: coin a contract sent on in it (a bridge delivering MON, say) then
 * shows only in the balance a reading takes. Only an RPC that gave no answer at all throws, so
 * the transaction is read again later.
 */
async function callsOf(client: ReturnType<typeof publicClient>, hash: Hash): Promise<CallFrame> {
  try {
    return (await client.request({
      method: "debug_traceTransaction",
      params: [hash, { tracer: "callTracer" }],
    } as never)) as CallFrame;
  } catch (error) {
    if (!rpcAnswered(error)) throw error;
    const tx = await client.getTransaction({ hash });
    return { type: "CALL", from: tx.from, ...(tx.to ? { to: tx.to } : {}), value: toHex(tx.value) };
  }
}

/**
 * An xStock: its balance, and so what a Transfer log moves, is its
 * shares times multiplier / 1e18, which its stock's dividends and splits
 * grow (STRCx's read 1.0973e18 on Monad in October 2026), while a price feed
 * prices one share (see XSTOCK_SHARES in chain-holdings.ts).
 */
const XSTOCK_MULTIPLIER = parseAbi(["function multiplier() view returns (uint256)"]);

/**
 * The multiplier of each of `tokens` that is an xStock, as of the block the
 * transaction was in, since a later dividend grows it. Throws while the
 * catalog can't tell an xStock apart, so the hint is tried again rather
 * than the stock valued too high.
 */
async function xStockMultipliers(
  client: ReturnType<typeof publicClient>,
  blockNumber: bigint,
  tokens: readonly string[],
): Promise<ReadonlyMap<string, bigint>> {
  if (tokens.length === 0) return new Map();
  const stocks = await evmXStocks();
  return new Map(
    await Promise.all(
      tokens
        .filter((token) => stocks.has(token))
        .map(
          async (token) =>
            [
              token,
              await client.readContract({
                address: token as Address,
                abi: XSTOCK_MULTIPLIER,
                functionName: "multiplier",
                blockNumber,
              }),
            ] as const,
        ),
    ),
  );
}

interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

/** A Solana transaction as getTransaction reads it with jsonParsed. */
export interface SolanaTransaction {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly fee: number;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly TokenBalance[];
    readonly postTokenBalances?: readonly TokenBalance[];
  } | null;
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly { readonly pubkey: string; readonly signer?: boolean }[];
    };
  };
}

/**
 * Every change a Solana transaction made to what `wallet` holds, from the
 * balances before and after it: one per mint its token accounts hold, and one
 * for SOL. These are net, so a transfer made inside another program shows
 * without reading any instruction. The fee isn't a transfer, so a wallet that
 * paid it has it added back.
 */
export function solanaTransfers(tx: SolanaTransaction, wallet: string): Transfer[] {
  const { meta } = tx;
  if (!meta || meta.err !== null) return [];
  const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey);
  const transfers: Transfer[] = [];

  // Each owner's change of each mint, in base units.
  const changes = new Map<string, Map<string, bigint>>();
  const decimals = new Map<string, number>();
  const count = (balances: readonly TokenBalance[] | undefined, sign: bigint) => {
    for (const balance of balances ?? []) {
      if (!balance.owner) continue;
      const byOwner = changes.get(balance.mint) ?? new Map<string, bigint>();
      const units = BigInt(balance.uiTokenAmount.amount) * sign;
      byOwner.set(balance.owner, (byOwner.get(balance.owner) ?? 0n) + units);
      changes.set(balance.mint, byOwner);
      decimals.set(balance.mint, balance.uiTokenAmount.decimals);
    }
  };
  count(meta.preTokenBalances, -1n);
  count(meta.postTokenBalances, 1n);
  for (const [mint, byOwner] of changes) {
    const units = byOwner.get(wallet) ?? 0n;
    if (units === 0n) continue;
    transfers.push({
      position: mint,
      instrument: solanaMintKey(mint).instrument,
      decimals: decimals.get(mint) ?? 0,
      baseUnits: units,
      counterparty: opposite(byOwner, wallet, units),
    });
  }

  const index = keys.indexOf(wallet);
  if (index >= 0) {
    const lamports = new Map(
      keys.map((key, at) => [
        key,
        BigInt((meta.postBalances[at] ?? 0) - (meta.preBalances[at] ?? 0)) +
          (at === 0 ? BigInt(meta.fee) : 0n),
      ]),
    );
    const units = lamports.get(wallet) ?? 0n;
    if (units !== 0n) {
      transfers.push({
        position: "native",
        instrument: "native",
        decimals: NETWORKS.solana.coin.decimals,
        baseUnits: units,
        counterparty: opposite(lamports, wallet, units),
      });
    }
  }
  return transfers;
}

/** The wallet's token accounts it held before `tx` and not after: closed, or handed to another owner. */
function closedAccounts(tx: SolanaTransaction, wallet: string): TokenAccount[] {
  const { meta } = tx;
  if (!meta || meta.err !== null) return [];
  const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey);
  const heldAfter = new Set(
    (meta.postTokenBalances ?? [])
      .filter((balance) => balance.owner === wallet)
      .map((balance) => balance.accountIndex),
  );
  return (meta.preTokenBalances ?? []).flatMap(({ accountIndex, mint, owner }) =>
    owner === wallet && !heldAfter.has(accountIndex)
      ? [{ address: keys[accountIndex]!, mint }]
      : [],
  );
}

/** Whoever's balance moved most the other way: the other side, as near as net changes tell. */
function opposite(
  changes: ReadonlyMap<string, bigint>,
  wallet: string,
  units: bigint,
): string | null {
  let best: string | null = null;
  let most = 0n;
  for (const [owner, change] of changes) {
    const against = units > 0n ? -change : change;
    if (owner !== wallet && against > most) [best, most] = [owner, against];
  }
  return best;
}

async function readSolana(signature: string, wallet: string): Promise<ChainTransaction> {
  const tx = await solanaRpc<SolanaTransaction | null>("getTransaction", [
    signature,
    // Most Solana transactions are now version 1; asked for 0 at most, the RPC refuses them.
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 },
  ]);
  if (!tx?.blockTime) throw new Error(`Solana transaction ${signature} isn't confirmed yet.`);
  return {
    at: new Date(tx.blockTime * 1_000),
    block: tx.slot,
    transfers: solanaTransfers(tx, wallet),
    // A sponsor may pay the fee, but only the wallet can sign to move what it holds.
    walletSigned: tx.transaction.message.accountKeys.some(
      (key) => key.pubkey === wallet && key.signer === true,
    ),
    closedAccounts: closedAccounts(tx, wallet),
  };
}

const SIGNATURES_PER_PAGE = 1_000;

/**
 * Pages of a listing, a thousand transactions each, one address or side
 * reads in a sweep, so spam anyone can send in floods is worked through a
 * few at a time.
 */
const PAGES_PER_SWEEP = 3;

/**
 * The Solana transactions that named `address` and didn't fail, newest
 * first, from slot `from` and, given `before`, older than that one. A
 * failed one moved nothing. After PAGES_PER_SWEEP pages it stops short of
 * `from` and gives the oldest it read as `resume`, to list on before next
 * time; it reads on while a page ends in slot `from` itself, as stopping
 * there would leave no slot read whole.
 */
export async function solanaSignatures(
  address: string,
  from: number,
  before?: string,
): Promise<{
  signatures: { hash: string; block: number }[];
  resume?: { hash: string; block: number };
}> {
  const signatures: { hash: string; block: number }[] = [];
  let older = before;
  for (let pages = 1; ; pages += 1) {
    const page = await solanaRpc<{ signature: string; slot: number; err: unknown }[]>(
      "getSignaturesForAddress",
      [
        address,
        {
          limit: SIGNATURES_PER_PAGE,
          commitment: "confirmed",
          ...(older ? { before: older } : {}),
        },
      ],
    );
    for (const { signature, slot, err } of page)
      if (slot >= from && err === null) signatures.push({ hash: signature, block: slot });
    const last = page.at(-1);
    if (!last || page.length < SIGNATURES_PER_PAGE || last.slot < from) return { signatures };
    if (pages >= PAGES_PER_SWEEP && last.slot > from)
      return { signatures, resume: { hash: last.signature, block: last.slot } };
    older = last.signature;
  }
}
