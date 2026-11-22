import { listed, NETWORKS, type EvmCashKey, type EvmChainKey } from "@auni/shared";
import {
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
} from "viem";

import { exactApproval } from "../approval.ts";
import { assertBytesDo } from "../approved.ts";
import { chainIdOf, evmClient, publicClient, rpcAnswered } from "../chains.ts";
import { EVM_NATIVE } from "../fill-key.ts";
import type { EvmTx, KeptTx, SentTx, Signer } from "../recipe.ts";
import { simulateEffect, walletEffect } from "../wallet-effect.ts";
import { feedListing } from "../token-feeds.ts";
import { evmMoves, type CallFrame } from "../transfers.ts";

export interface EvmToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly usdPrice: number | null;
}

/** "USDC" or the chain's native USDC address. */
export function isEvmUsdc(chainName: EvmCashKey, token: string): boolean {
  const query = token.trim();
  return (
    query.toUpperCase() === "USDC" || query.toLowerCase() === NETWORKS[chainName].usdc.toLowerCase()
  );
}

/** "USDC", the native symbol, another symbol a token feed knows, or any ERC-20 address. */
export async function resolveEvmToken(chainName: EvmCashKey, token: string): Promise<EvmToken> {
  const config = NETWORKS[chainName];
  const query = token.trim();
  if (isEvmUsdc(chainName, query)) {
    return { address: config.usdc, symbol: "USDC", decimals: 6, usdPrice: 1 };
  }
  const native = config.viem.nativeCurrency;
  if (
    query.toUpperCase() === native.symbol.toUpperCase() ||
    query.toLowerCase() === EVM_NATIVE.toLowerCase()
  ) {
    const coin = await feedListing(chainName, native.symbol).catch(() => null);
    return {
      address: EVM_NATIVE,
      symbol: native.symbol,
      decimals: native.decimals,
      usdPrice: coin?.usdPrice ?? null,
    };
  }
  const known = await feedListing(chainName, query).catch(() => null);
  if (known) {
    return {
      address: getAddress(known.address),
      symbol: known.symbol,
      decimals: known.decimals,
      usdPrice: known.usdPrice,
    };
  }
  if (!isAddress(query))
    throw new Error(`Unknown token "${query}" on ${chainName}. Pass its contract address.`);
  const client = publicClient(chainName);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: query, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: query, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address: getAddress(query), symbol, decimals, usdPrice: null };
}

/** What a sent swap paid the wallet, once final. 0n when nothing filled, and then `note` says why. */
export interface SwapSent {
  readonly txs: readonly SentTx[];
  readonly received: bigint;
  readonly note?: string;
  /**
   * Paid by a maker from its own transaction, whose hash the venue never
   * says: then exactly `received` is what its arrival is known by.
   */
  readonly makerPaid?: true;
  /** What it sold, from a venue that can sell less than asked (an xStock refunded a wei short); else all of it. */
  readonly sold?: bigint;
}

export interface EvmRoute {
  /** The venue's name, which a swap records as where it filled. */
  readonly provider: string;
  /** What the wallet gets, after every fee the venue takes. */
  readonly buyAmount: bigint;
  readonly minBuyAmount: bigint;
  /**
   * The markets an aggregator filled it on, by the names people know them by, not its ids for
   * them; absent for a venue that fills it itself.
   */
  readonly filledOn?: readonly string[];
  /** Present on an aggregator's executable quotes (a taker was given). */
  readonly spender?: Address;
  readonly transaction?: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  /**
   * Present on executable quotes: sends this route from the owner's wallet and
   * returns only once the trade is final.
   */
  readonly send?: (wallets: Signer) => Promise<SwapSent>;
}

/** The services a route goes through, in the owner's words: its provider, and the markets it filled on. */
export function throughOf(route: Pick<EvmRoute, "provider" | "filledOn">): string {
  const markets = route.filledOn?.filter((market) => market !== route.provider) ?? [];
  return markets.length ? `${route.provider}, filled on ${listed(markets)}` : route.provider;
}

export interface EvmQuoteRequest {
  readonly chain: EvmCashKey;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly sellAmount: bigint;
  readonly slippageBps: number;
  /** Omit for an indicative price; pass the owner's address for an executable transaction. */
  readonly taker?: Address;
}

/** The least a route quoting `amount` may pay out, `slippageBps` below it. */
export function slippageFloor(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** What `owner` holds of `token`, now or as of the end of `blockNumber`. */
export async function evmBalance(
  chain: EvmChainKey,
  token: Address,
  owner: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  const client = publicClient(chain);
  const at = blockNumber === undefined ? {} : { blockNumber };
  return token === EVM_NATIVE
    ? client.getBalance({ address: owner, ...at })
    : client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        ...at,
      });
}

/**
 * Sends the route from the owner's wallet, with an approval of exactly what it
 * spends (never unlimited) in the same batch, so none outlives a swap that
 * fails. The route built the swap's bytes, so the batch is simulated first and
 * held to what Auni asked of them (see assertBytesDo): no more than the sale
 * leaves, at least the route's least lands in the wallet, and no permission
 * is left behind. Returns the batch and what the swap paid the wallet.
 * `setup` marks the swap as a funding step before another move, so it alone
 * never settles that move's action.
 */
export async function sendEvmSwap(
  wallets: Signer,
  request: EvmQuoteRequest,
  route: EvmRoute,
  options: { readonly setup?: true } = {},
): Promise<SwapSent> {
  const chainId = NETWORKS[request.chain].viem.id;
  const owner = getAddress(wallets.evmAddress);
  const setup = options.setup ? { setup: true as const } : {};
  const calls = await swapCalls(request, route, owner, setup);
  assertBytesDo(await simulateEffect(chainId, owner, calls), {
    gives: [{ token: request.sellToken, amount: request.sellAmount }],
    gets: [{ token: request.buyToken, amount: route.minBuyAmount }],
  });
  const hash = (await wallets.sendEvmTransaction(chainId, calls)) as Hex;
  const receipt = await confirm(publicClient(request.chain), hash, "swap");
  return {
    txs: [{ chain: request.chain, hash, ...setup }],
    received: await receivedBy(request.chain, receipt, request.buyToken, owner),
  };
}

/**
 * The calls that send a route from `owner`, as one batch: an exact approval of what it spends
 * where one is needed, then the route's own transaction, marked `mark` (a funding step's setup).
 */
export async function swapCalls(
  request: EvmQuoteRequest,
  route: EvmRoute,
  owner: Address,
  mark: Pick<EvmTx, "setup"> = {},
): Promise<EvmTx[]> {
  if (!route.transaction) throw new Error("The route has no transaction to send.");
  const spender = route.spender ?? route.transaction.to;
  const approval =
    request.sellToken === EVM_NATIVE
      ? null
      : await exactApproval(request.chain, request.sellToken, owner, spender, request.sellAmount);
  return [
    ...(approval ? [approval] : []),
    {
      to: route.transaction.to,
      data: route.transaction.data,
      value: route.transaction.value.toString(),
      ...mark,
    },
  ];
}

/**
 * What this one transaction paid the owner: its token transfers, so another
 * move in the same block can't blur it. The chain's coin leaves no transfer
 * log, so it is read from the transaction's call trace (see coinMoved); where
 * the RPC serves no traces, from the owner's balance across the block with the
 * fee it paid for this transaction put back, which anything else that moved
 * its coin in that block blurs. An xStock's wallet can be credited a wei less
 * than its Transfer says; a sale of it sells the balance when a crumb short
 * (evm-swap.ts).
 */
export async function receivedBy(
  chain: EvmChainKey,
  receipt: TransactionReceipt,
  token: Address,
  owner: Address,
): Promise<bigint> {
  if (token === EVM_NATIVE) {
    const traced = await coinMoved(chain, receipt.transactionHash, owner);
    if (traced) return traced.in;
    const [before, after] = await Promise.all([
      evmBalance(chain, token, owner, receipt.blockNumber - 1n),
      evmBalance(chain, token, owner, receipt.blockNumber),
    ]);
    const fee = isAddressEqual(receipt.from, owner)
      ? receipt.gasUsed * receipt.effectiveGasPrice
      : 0n;
    return after - before + fee;
  }
  const leg = walletEffect(receipt.logs, owner).in.find((each) =>
    isAddressEqual(each.token, token),
  );
  return leg?.amount ?? 0n;
}

/**
 * The chain's coin one transaction moved into and out of `owner`, read from its call trace:
 * every call that carried coin, at any depth, and none under a call that reverted. Exact, where
 * a balance read across a block counts whatever else moved the coin in it. Null where the RPC
 * serves no traces.
 */
export async function coinMoved(
  chain: string,
  hash: Hex,
  owner: Address,
): Promise<{ readonly in: bigint; readonly out: bigint } | null> {
  let trace: CallFrame;
  try {
    trace = (await evmClient(chainIdOf(chain)).request({
      method: "debug_traceTransaction",
      params: [hash, { tracer: "callTracer" }],
    } as never)) as CallFrame;
  } catch (error) {
    if (rpcAnswered(error)) return null;
    throw error;
  }
  const coin = evmMoves(chain, [], trace, owner).filter(({ token }) => token === null);
  const sum = (units: readonly bigint[]) => units.reduce((total, each) => total + each, 0n);
  return {
    in: sum(coin.flatMap(({ baseUnits }) => (baseUnits > 0n ? [baseUnits] : []))),
    out: sum(coin.flatMap(({ baseUnits }) => (baseUnits < 0n ? [-baseUnits] : []))),
  };
}

/**
 * The chain's coin a move's confirmed sends moved into and out of `owner` between them, each
 * read from its own trace, so two sends in one block count once each; null when any trace
 * can't be read.
 */
export async function coinMovedBy(
  chain: string,
  receipts: readonly TransactionReceipt[],
  owner: Address,
): Promise<{ readonly in: bigint; readonly out: bigint } | null> {
  const each = await Promise.all(
    receipts.map(({ transactionHash }) => coinMoved(chain, transactionHash, owner)),
  );
  if (each.some((moved) => moved === null)) return null;
  return {
    in: each.reduce((sum, moved) => sum + moved!.in, 0n),
    out: each.reduce((sum, moved) => sum + moved!.out, 0n),
  };
}

/**
 * The receipts of a move's sends on `chain` that confirmed, read now, each hash once: what a
 * recipe reads back of a move whose run stopped after sending (see Recipe.readBack). A hash the
 * chain doesn't know (a stuck send's, replaced at a higher fee) and one that reverted are left
 * out, and so is what its card bought for fees (KeptTx.buysFees), which is no part of the move:
 * a swap of a little USDC for the chain's coin would read as the move's own trade. Any other
 * failure to read throws, so nothing is read back from half of what was sent.
 */
export async function confirmedReceipts(
  chain: string,
  txs: readonly KeptTx[],
): Promise<TransactionReceipt[]> {
  const client = evmClient(chainIdOf(chain));
  const hashes = [
    ...new Set(
      txs.flatMap((tx) => (tx.chain === chain && tx.hash && !tx.buysFees ? [tx.hash] : [])),
    ),
  ];
  const receipts = await Promise.all(
    hashes.map((hash) =>
      client.getTransactionReceipt({ hash: hash as Hex }).catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }),
    ),
  );
  return receipts.filter((receipt) => receipt?.status === "success") as TransactionReceipt[];
}

/** Waits for the transaction to succeed. */
export async function confirm(
  client: PublicClient,
  hash: Hex,
  label: string,
): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`The ${label} transaction ${hash} reverted.`);
  return receipt;
}
