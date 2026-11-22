import { NETWORKS } from "@auni/shared";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  concat,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  numberToHex,
  pad,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { publicClient } from "../../money/chains.ts";
import type { SentTx, Signer } from "../../money/recipe.ts";
import {
  confirm,
  slippageFloor,
  type EvmQuoteRequest,
  type EvmRoute,
  type SwapSent,
} from "../../money/swaps/evm.ts";
import { fetchJson } from "../../money/swaps/shared.ts";

/**
 * LI.FI Intents on Monad, straight to its escrow rather than through LI.FI's
 * router: order.li.fi asks its market makers for a price, the wallet locks
 * what it sells in the escrow with an order for exactly that price, and the
 * maker pays the owner from its own transaction, usually a block or two later.
 * The router would add a 0.25% fee, and its exact-balance check fails about
 * half of all xStock sales, since an xStock can move a wei less than asked.
 *
 * Stocks on Monad have one maker, which posts its prices ahead and skips an
 * order once the market outruns them; a skipped order is offered once more,
 * lower, but never under the least this trade lets land.
 */

/** InputSettlerEscrow: holds what an order sells until a maker fills it or it is refunded. */
const ESCROW: Address = "0x00fC00edbe7C003b006f870068c548940000223e";
/** OutputSettlerSimple: where the maker pays the owner, and for a same-chain order the proof that it did. */
const SETTLER: Address = "0x75220B7600c300005038432a0000f308e0000068";
const MONAD = NETWORKS.monad.viem.id;
/** How long a maker has to fill, which it does in a block or two; past it the wallet takes its money back. */
const FILL_WAIT_S = 30;
// The escrow's orderStatus: 0 none, 1 deposited, then one of these two, for good.
const CLAIMED = 2;
const REFUNDED = 3;
/** The most a second order gives below the maker's fresh price: its posted prices strayed under 0.9% in October 2026. */
const SECOND_ORDER_ROOM_BPS = 100;

const escrowAbi = parseAbi([
  "struct MandateOutput { bytes32 oracle; bytes32 settler; uint256 chainId; bytes32 token; uint256 amount; bytes32 recipient; bytes callbackData; bytes context; }",
  "struct StandardOrder { address user; uint256 nonce; uint256 originChainId; uint32 expires; uint32 fillDeadline; address inputOracle; uint256[2][] inputs; MandateOutput[] outputs; }",
  "function open(StandardOrder order)",
  "function refund(StandardOrder order)",
  "function orderIdentifier(StandardOrder order) view returns (bytes32)",
  "function orderStatus(bytes32 orderId) view returns (uint8)",
]);

interface QuoteResponse {
  /** Best first. */
  readonly quotes: readonly {
    readonly preview: { readonly outputs: readonly { readonly amount: string }[] };
    readonly metadata: { readonly exclusiveFor: string | null };
  }[];
}

/** An address on Monad as order.li.fi names it (ERC-7930): version 1, an EVM chain, chain 143, then the address. */
const onMonad = (address: Address) => `0x00010000018f14${address.slice(2)}`;

/** What the best maker pays for this exact trade, and the maker, which alone may fill it. */
interface MakerQuote {
  readonly amount: bigint;
  readonly maker: Address | null;
}

/** Null when no maker quotes. */
async function makerQuote(request: EvmQuoteRequest): Promise<MakerQuote | null> {
  // A price alone needs some user; the zero address gets the same quote.
  const user = onMonad(request.taker ?? zeroAddress);
  const { quotes } = await fetchJson<QuoteResponse>("https://order.li.fi/quote/request", {
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user,
        intent: {
          intentType: "oif-swap",
          inputs: [
            { user, asset: onMonad(request.sellToken), amount: request.sellAmount.toString() },
          ],
          outputs: [{ receiver: user, asset: onMonad(request.buyToken), amount: null }],
          swapType: "exact-input",
        },
        supportedTypes: ["oif-escrow-v0"],
      }),
    },
  });
  const amount = quotes[0]?.preview.outputs[0]?.amount;
  if (!amount) return null;
  const maker = quotes[0]?.metadata.exclusiveFor;
  return { amount: BigInt(amount), maker: maker ? getAddress(maker) : null };
}

/** A maker's price for this exact trade; with a taker, the route opens an order at it. */
export async function quoteLifiIntents(request: EvmQuoteRequest): Promise<EvmRoute> {
  if (request.chain !== "monad") throw new Error("only trades on Monad");
  const quoted = await makerQuote(request);
  // Backed, which the makers buy from and sell to, takes no order under $10.
  if (!quoted)
    throw new Error("no maker is quoting this trade right now, and makers fill only $10 or more");
  const route: EvmRoute = {
    provider: "LI.FI",
    buyAmount: quoted.amount,
    // An order pays exactly what it asks or nothing; execute holds this to the card's least.
    minBuyAmount: slippageFloor(quoted.amount, request.slippageBps),
  };
  const { taker } = request;
  if (!taker) return route;
  return {
    ...route,
    send: (wallets) => fill(wallets, request, taker, quoted, route.minBuyAmount),
  };
}

/**
 * An order at the maker's quote; once refunded, one more at `least`, or the
 * maker's fresh price less up to SECOND_ORDER_ROOM_BPS if that is higher.
 * The second sells what the wallet holds, up to what the first sold, since a
 * refunded xStock can come back a wei short.
 */
async function fill(
  wallets: Signer,
  request: EvmQuoteRequest,
  user: Address,
  quoted: MakerQuote,
  least: bigint,
): Promise<SwapSent> {
  const first = await openOrder(wallets, request, user, quoted.amount, quoted.maker);
  if (first.received > 0n) return first;
  // Nothing is sent until both are known, so a failed read leaves the refund the answer.
  const [fresh, held] = await Promise.all([
    makerQuote(request),
    publicClient("monad").readContract({
      address: request.sellToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    }),
  ]).catch(() => [null, 0n] as const);
  if (!fresh || fresh.amount < least || held === 0n) return first;
  const floor = slippageFloor(fresh.amount, Math.min(request.slippageBps, SECOND_ORDER_ROOM_BPS));
  const second = await openOrder(
    wallets,
    { ...request, sellAmount: held < request.sellAmount ? held : request.sellAmount },
    user,
    floor > least ? floor : least,
    fresh.maker,
  );
  return { ...second, txs: [...first.txs, ...second.txs] };
}

/**
 * Opens an order for `buyAmount`, approving exactly what it sells in the same batch, and
 * waits for the maker. Unfilled once it has expired by the chain's clock, the
 * wallet refunds it. A fill landing in that same moment makes the refund
 * revert, so the order's last status decides.
 */
async function openOrder(
  wallets: Signer,
  request: EvmQuoteRequest,
  user: Address,
  buyAmount: bigint,
  maker: Address | null,
): Promise<SwapSent> {
  const client = publicClient("monad");
  const deadline = Math.floor(Date.now() / 1_000) + FILL_WAIT_S;
  const order = {
    user,
    // The escrow refuses an order it has seen, so each needs its own.
    nonce: BigInt(toHex(randomBytes(32))),
    originChainId: BigInt(MONAD),
    expires: deadline,
    fillDeadline: deadline,
    inputOracle: SETTLER,
    inputs: [[BigInt(request.sellToken), request.sellAmount]] as const,
    outputs: [
      {
        oracle: pad(SETTLER),
        settler: pad(SETTLER),
        chainId: BigInt(MONAD),
        token: pad(request.buyToken),
        amount: buyAmount,
        recipient: pad(user),
        callbackData: "0x",
        // The maker that quoted is the only one who may fill, which is what it quoted on.
        context: maker ? concat(["0xe0", pad(maker), numberToHex(deadline, { size: 4 })]) : "0x",
      },
    ],
  } as const;
  const id = await client.readContract({
    address: ESCROW,
    abi: escrowAbi,
    functionName: "orderIdentifier",
    args: [order],
  });
  const opened = (await wallets.sendEvmTransaction(MONAD, [
    {
      to: request.sellToken,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [ESCROW, request.sellAmount],
      }),
    },
    {
      to: ESCROW,
      data: encodeFunctionData({ abi: escrowAbi, functionName: "open", args: [order] }),
    },
  ])) as Hex;
  const txs: SentTx[] = [{ chain: "monad", hash: opened }];
  await confirm(client, opened, "order");

  const latest = async () => {
    const block = await client.getBlock();
    const status = await client.readContract({
      address: ESCROW,
      abi: escrowAbi,
      functionName: "orderStatus",
      args: [id],
      blockNumber: block.number,
    });
    return { block, status };
  };
  let last = await latest();
  while (last.status < CLAIMED && last.block.timestamp <= BigInt(deadline)) {
    // An RPC stuck on an old block never passes the deadline; a person checks then.
    if (Date.now() / 1_000 > deadline + 60)
      throw new Error(
        `No Monad block past LI.FI order ${id}'s deadline came, so whether it filled is unknown.`,
      );
    await sleep(1_000);
    last = await latest();
  }
  let refundFailed: unknown;
  if (last.status < CLAIMED) {
    try {
      const refunded = (await wallets.sendEvmTransaction(MONAD, {
        to: ESCROW,
        data: encodeFunctionData({ abi: escrowAbi, functionName: "refund", args: [order] }),
        setup: true,
      })) as Hex;
      txs.push({ chain: "monad", hash: refunded, setup: true });
      // The wallet saw it land; this RPC may be a block behind, and the status read must not be.
      await confirm(client, refunded, "refund");
    } catch (error) {
      refundFailed = error;
    }
    last = await latest();
  }

  // A claimed order paid exactly what it asked.
  if (last.status === CLAIMED)
    return { txs, received: buyAmount, makerPaid: true, sold: request.sellAmount };
  if (last.status === REFUNDED)
    return { txs, received: 0n, note: "No one filled the order on Monad, so nothing was traded." };
  throw new Error(
    `LI.FI order ${id} went unfilled and its refund didn't go through (${String(refundFailed)}). ` +
      "What it sold waits in LI.FI's escrow, which anyone can refund.",
  );
}
