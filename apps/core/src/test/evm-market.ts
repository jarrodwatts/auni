import type { EvmCashKey } from "@auni/shared";
import {
  encodeAbiParameters,
  getAddress,
  pad,
  toEventSelector,
  type Address,
  type Log,
} from "viem";
import { vi } from "vitest";

import { publicClient } from "../money/chains.ts";
import {
  evmBalance,
  resolveEvmToken,
  sendEvmSwap,
  slippageFloor,
  type EvmRoute,
  type EvmToken,
} from "../money/swaps/evm.ts";
import { quoteStock, quoteSwap } from "../money/swaps/routes.ts";
import { simulateEffect, walletEffect } from "../money/wallet-effect.ts";
import { OWNER } from "./wallets.ts";

// One EVM chain's market, stood in for, for drills of the recipes that swap there (see
// test/held-to-card.ts): tokens at dollar prices, the owner's balances, and one route that trades
// any pair at those prices. Its bytes are sent as the real routes' are, through sendEvmSwap: an
// exact approval, a simulation of the batch, and what landed read from the receipt, so what the
// bytes would really do (`bytes`) is what the simulation and the receipt say. A test file using
// it mocks what it fills in:
//
//   vi.mock(import("../money/swaps/evm.ts"), async (o) => ({ ...(await o()), resolveEvmToken: vi.fn(), evmBalance: vi.fn() }));
//   vi.mock(import("../money/swaps/routes.ts"), async (o) => ({ ...(await o()), quoteSwap: vi.fn(), quoteStock: vi.fn() }));
//   vi.mock(import("../money/wallet-effect.ts"), async (o) => ({ ...(await o()), simulateEffect: vi.fn() }));

/** The router every route sends through. */
export const ROUTER = getAddress("0x00000000000000000000000000000000000d3e00");
/** Someone who isn't the owner. */
const STRANGER = getAddress("0x5555555555555555555555555555555555555555");

/** What a route's bytes really do, past what it quoted. */
type RouteBytes = "honest" | "pay a stranger" | "leave an approval";

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const APPROVAL = toEventSelector("Approval(address,address,uint256)");
const log = (selector: `0x${string}`, token: Address, from: Address, to: Address, units: bigint) =>
  ({
    address: token,
    topics: [selector, pad(from), pad(to)],
    data: encodeAbiParameters([{ type: "uint256" }], [units]),
  }) as unknown as Log;

const micros = (usd: number) => BigInt(Math.round(usd * 1e6));

export function evmMarket(chain: EvmCashKey, tokens: readonly EvmToken[]) {
  const market = {
    /** Dollars a token trades at on the route, by address. */
    usd: new Map<string, number>(),
    /** What the owner's wallet holds, by token address. */
    held: new Map<string, bigint>(),
    bytes: "honest" as RouteBytes,
    /** Opens it as each run finds it: every token at its listed price, holding `held`. */
    open(held: ReadonlyMap<string, bigint>) {
      market.usd = new Map(tokens.map((token) => [token.address, token.usdPrice ?? 0]));
      market.held = new Map(held);
      market.bytes = "honest";
      vi.mocked(resolveEvmToken).mockImplementation(async (_, query) => tokenOf(query));
      vi.mocked(evmBalance).mockImplementation(async (_, token) => market.held.get(token) ?? 0n);
      vi.mocked(quoteSwap).mockImplementation(async (request) => route(request));
      vi.mocked(quoteStock).mockImplementation(async (request) => route(request));
      // The wallet hasn't let the router spend anything yet.
      vi.spyOn(publicClient(chain), "readContract").mockResolvedValue(0n as never);
      vi.mocked(simulateEffect).mockImplementation(async (_, owner) => {
        const logs = lastTrade();
        return { ...walletEffect(logs, owner), blind: false, logs };
      });
      vi.spyOn(publicClient(chain), "waitForTransactionReceipt").mockImplementation(
        async () => ({ status: "success", blockNumber: 1n, logs: lastTrade() }) as never,
      );
    },
  };

  const tokenOf = (query: string): EvmToken => {
    const token = tokens.find(
      (each) => each.symbol === query || each.address.toLowerCase() === query.toLowerCase(),
    );
    if (!token) throw new Error(`The fake market lists no ${query}.`);
    return { ...token, usdPrice: market.usd.get(token.address) ?? token.usdPrice };
  };

  let last: { sell: Address; sold: bigint; buy: Address; bought: bigint } | null = null;

  /** The route's quote for `request` at today's prices, which sends through sendEvmSwap. */
  function route(request: Parameters<typeof quoteSwap>[0]): EvmRoute {
    const [sell, buy] = [tokenOf(request.sellToken), tokenOf(request.buyToken)];
    const buyAmount =
      (request.sellAmount * micros(market.usd.get(sell.address)!) * 10n ** BigInt(buy.decimals)) /
      (micros(market.usd.get(buy.address)!) * 10n ** BigInt(sell.decimals));
    const quoted: EvmRoute = {
      provider: "Test DEX",
      buyAmount,
      minBuyAmount: slippageFloor(buyAmount, request.slippageBps),
      spender: ROUTER,
      transaction: { to: ROUTER, data: "0x5ae401dc", value: 0n },
    };
    last = { sell: sell.address, sold: request.sellAmount, buy: buy.address, bought: buyAmount };
    return request.taker
      ? { ...quoted, send: (wallets) => sendEvmSwap(wallets, request, quoted) }
      : quoted;
  }

  /** What the bytes of the route quoted last do to the wallet. */
  function lastTrade(): Log[] {
    if (!last) throw new Error("Nothing was quoted.");
    const payee = market.bytes === "pay a stranger" ? STRANGER : OWNER.evm;
    return [
      log(TRANSFER, last.sell, OWNER.evm, ROUTER, last.sold),
      log(TRANSFER, last.buy, ROUTER, payee, last.bought),
      ...(market.bytes === "leave an approval"
        ? [log(APPROVAL, last.buy, OWNER.evm, STRANGER, 2n ** 255n)]
        : []),
    ];
  }

  return market;
}
