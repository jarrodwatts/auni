import { NETWORKS } from "@auni/shared";
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import { publicClient } from "../../money/chains.ts";
import { usdLabel } from "../../money/format.ts";
import type { EvmTx, SentTx, Signer } from "../../money/recipe.ts";
import {
  confirm,
  receivedBy,
  slippageFloor,
  type EvmQuoteRequest,
  type EvmRoute,
  type SwapSent,
} from "../../money/swaps/evm.ts";
import { fromBaseUnits } from "../../money/swaps/shared.ts";

// Kuru's order books on Monad (docs.kuru.io/deployments/mainnet). Money is
// traded from a Kuru account held in AccountCore: deposit, swap, withdraw.
const ACCOUNT_CORE: Address = "0x264123a9B96Cc1193944cC25C188f1bD3dFa670e";
const WITHDRAWAL_LIMITER: Address = "0xF059F4AAb49Bd3AFB62134145EeAF38Fe103F0eA";

/** Each xStock Kuru has a book for, by symbol: the stock's token and its book, quoted in Monad's USDC. */
const BOOKS = {
  NVDAx: {
    token: "0xc845b2894dBddd03858fd2D643B4eF725fE0849d",
    book: "0xf3FB2ec6ffb2A24506769bfaA3aD9B1EeB7D41Eb",
  },
  SPYx: {
    token: "0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48",
    book: "0xBb180c8B6D3eE0b4316B224C53B80dC4e354d24F",
  },
  QQQx: {
    token: "0xa753A7395cAe905Cd615Da0B82A53E0560f250af",
    book: "0xEdf008258139ee23cf2bDB9C360f69131dC72708",
  },
  TSLAx: {
    token: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0",
    book: "0xf884c7631a7150F28c139a3A9f8B669258b5b285",
  },
  EWYx: {
    token: "0x299c95Eb52BFd5Bc98d924bCE17197b64864589B",
    book: "0xED3727e833200c849fbd18e15eD0D091c9B0F3aF",
  },
} as const satisfies Record<string, { readonly token: Address; readonly book: Address }>;

/** The xStocks Kuru trades at any size, by symbol (NVDAx). */
export const KURU_STOCKS: readonly string[] = Object.keys(BOOKS);

const BOOK_OF: ReadonlyMap<Address, Address> = new Map(
  Object.values(BOOKS).map(({ token, book }) => [getAddress(token), book]),
);

const accountAbi = parseAbi([
  "function rootAccountIdOf(address owner) view returns (uint40)",
  "function getBalance(uint40 accountId, address token) view returns (uint256)",
  "function createSubaccount(address rootOwner) returns (uint40)",
  "function deposit(address rootOwner, address token, uint256 amount)",
  "function withdraw(uint40 rootAccountId, address token, uint256 amount, address recipient)",
]);
const bookAbi = parseAbi([
  "function baseSizeMultiplier() view returns (uint96)",
  "function estimateSwap(bool isBuy, uint128 amountIn) view returns (uint128 amountInUsed, uint128 amountOut)",
  "function swap(uint40 userId, bool isBuy, uint128 amountIn, uint128 minAmountOut, uint64 deadline) returns (uint128 amountInUsed, uint128 amountOut)",
]);
const limiterAbi = parseAbi([
  "function previewWithdrawal(address token, uint256 amount) view returns (uint256 requiredUsd36, uint256 availableUsd36, bool withinLimit)",
]);

/** How long a sent trade stays good; one that lands later reverts whole. Kuru counts it in seconds. */
const DEADLINE_S = 120;

const LEFT_IN_KURU =
  "Part of this trade's proceeds is still in the owner's Kuru account; their next Kuru trade, of any stock, brings it home.";

/** A book trades only whole size steps of its stock. */
const stepOf = (book: Address) =>
  publicClient("monad").readContract({
    address: book,
    abi: bookAbi,
    functionName: "baseSizeMultiplier",
  });

/** A stock trade on one of Kuru's books, priced by the book itself on the exact amount. */
export async function kuruQuote(request: EvmQuoteRequest): Promise<EvmRoute> {
  const usdc = NETWORKS.monad.usdc;
  const buys = isAddressEqual(request.sellToken, usdc);
  const stock = buys ? request.buyToken : request.sellToken;
  const book =
    request.chain === "monad" && (buys || isAddressEqual(request.buyToken, usdc))
      ? BOOK_OF.get(getAddress(stock))
      : undefined;
  if (!book) throw new Error("no book for this stock");

  const client = publicClient("monad");
  const step = await stepOf(book);
  // A buy trades all the USDC. A sale trades whole size steps of what Kuru
  // credits, which for an xStock can be a wei less than was sent.
  const amountIn = buys ? request.sellAmount : ((request.sellAmount - 1n) / step) * step;
  if (amountIn <= 0n) throw new Error("too small for its book");
  const [amountInUsed, amountOut] = await client.readContract({
    address: book,
    abi: bookAbi,
    functionName: "estimateSwap",
    args: [buys, amountIn],
  });
  if (amountInUsed < amountIn) {
    const fillsUsdc = buys ? amountInUsed : amountOut;
    throw new Error(`its book can fill only ${usdLabel(fromBaseUnits(fillsUsdc, 6))} of this now`);
  }
  // Every withdrawal from Kuru draws on one limit shared by all its users.
  const [, , fits] = await client.readContract({
    address: WITHDRAWAL_LIMITER,
    abi: limiterAbi,
    functionName: "previewWithdrawal",
    args: [request.buyToken, amountOut],
  });
  if (!fits) throw new Error("its shared withdrawal limit can't pay this out now");

  const minBuyAmount = slippageFloor(amountOut, request.slippageBps);
  const route: EvmRoute = {
    provider: "Kuru",
    buyAmount: amountOut,
    minBuyAmount,
  };
  if (!request.taker) return route;

  // One batch that lands whole or not at all: the swap promises at least the
  // minimum, so that much is safe to withdraw in the same breath.
  const trade = (id: number, owner: Address): EvmTx[] => {
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + DEADLINE_S);
    return [
      {
        to: request.sellToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [ACCOUNT_CORE, request.sellAmount],
        }),
      },
      {
        to: ACCOUNT_CORE,
        data: encodeFunctionData({
          abi: accountAbi,
          functionName: "deposit",
          args: [owner, request.sellToken, request.sellAmount],
        }),
      },
      {
        to: book,
        data: encodeFunctionData({
          abi: bookAbi,
          functionName: "swap",
          args: [id, buys, amountIn, minBuyAmount, deadline],
        }),
      },
      withdrawal(id, request.buyToken, minBuyAmount, owner),
    ];
  };
  return {
    ...route,
    send: (wallets) => sendTrade(wallets, request, trade),
  };
}

/**
 * Opens the owner's Kuru account if this is their first trade, sends the
 * trade, then brings home all the account holds, so money only passes
 * through it. What the trade bought is what reached the wallet plus what it
 * added to the account, so it is right whether or not the sweep lands, and a
 * leftover from an earlier trade is never counted again. Monad stock
 * trades run one at a time, so nothing else moves their Kuru account meanwhile.
 */
async function sendTrade(
  wallets: Signer,
  request: EvmQuoteRequest,
  trade: (id: number, owner: Address) => EvmTx[],
): Promise<SwapSent> {
  const client = publicClient("monad");
  const chainId = NETWORKS.monad.viem.id;
  const owner = getAddress(wallets.evmAddress);
  const accountOf = () =>
    client.readContract({
      address: ACCOUNT_CORE,
      abi: accountAbi,
      functionName: "rootAccountIdOf",
      args: [owner],
    });
  const txs: SentTx[] = [];
  let id = await accountOf();
  if (id === 0) {
    // A deposit opens the account too, but a withdrawal must name it, so it
    // opens first. This call opens it without moving money (and an unused
    // subaccount with it).
    const opened = (await wallets.sendEvmTransaction(chainId, {
      to: ACCOUNT_CORE,
      data: encodeFunctionData({
        abi: accountAbi,
        functionName: "createSubaccount",
        args: [owner],
      }),
      setup: true,
    })) as Hex;
    txs.push({ chain: "monad", hash: opened, setup: true });
    await confirm(client, opened, "Kuru account");
    id = await accountOf();
  }
  const traded = (await wallets.sendEvmTransaction(chainId, trade(id, owner))) as Hex;
  txs.push({ chain: "monad", hash: traded });
  const receipt = await confirm(client, traded, "Kuru trade");
  const heldAt = (token: Address, blockNumber: bigint) =>
    client.readContract({
      address: ACCOUNT_CORE,
      abi: accountAbi,
      functionName: "getBalance",
      args: [id, token],
      blockNumber,
    });
  const [paid, before, after] = await Promise.all([
    receivedBy("monad", receipt, request.buyToken, owner),
    heldAt(request.buyToken, receipt.blockNumber - 1n),
    heldAt(request.buyToken, receipt.blockNumber),
  ]);
  const received = paid + after - before;
  // The surplus over the minimum, any USDC a part-filled buy didn't spend,
  // and whatever an earlier sweep couldn't bring home, in any stock. Under one
  // size step of a stock is worth nothing and too little to withdraw
  // reliably, so that stays.
  const bringHome = async (token: Address, least: bigint) => {
    const amount = await heldAt(token, receipt.blockNumber);
    return amount >= least
      ? [{ ...withdrawal(id, token, amount, owner), setup: true as const }]
      : [];
  };
  // The trade has landed, so failing to read or send the sweep costs only the sweep.
  try {
    const sweep = (
      await Promise.all([
        bringHome(NETWORKS.monad.usdc, 1n),
        ...Object.values(BOOKS).map(async ({ token, book }) =>
          bringHome(token, await stepOf(book)),
        ),
      ])
    ).flat();
    if (sweep.length === 0) return { txs, received };
    // Back once the wallet saw it land, or a throw when it reverted; nothing is left to wait for.
    const swept = (await wallets.sendEvmTransaction(chainId, sweep)) as Hex;
    return { txs: [...txs, { chain: "monad", hash: swept, setup: true }], received };
  } catch (error) {
    console.error("Kuru sweep failed", error);
    return { txs, received, note: LEFT_IN_KURU };
  }
}

function withdrawal(id: number, token: Address, amount: bigint, to: Address): EvmTx {
  return {
    to: ACCOUNT_CORE,
    data: encodeFunctionData({
      abi: accountAbi,
      functionName: "withdraw",
      args: [id, token, amount, to],
    }),
  };
}
