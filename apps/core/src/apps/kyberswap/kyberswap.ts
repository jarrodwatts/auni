import { NETWORKS } from "@auni/shared";
import { getAddress, type Hex } from "viem";

import {
  sendEvmSwap,
  slippageFloor,
  type EvmQuoteRequest,
  type EvmRoute,
} from "../../money/swaps/evm.ts";
import { cached, fetchJson } from "../../money/swaps/shared.ts";

interface KyberRouteResponse {
  readonly data?: {
    readonly routeSummary: {
      readonly amountOut: string;
      readonly route: readonly (readonly { readonly exchange: string }[])[];
    };
    readonly routerAddress: string;
  };
}

interface KyberBuildResponse {
  readonly data: {
    readonly amountOut: string;
    readonly data: string;
    readonly routerAddress: string;
    readonly transactionValue: string;
  };
}

/**
 * What KyberSwap calls each market it routes through on a chain, by its id for it, kept a day:
 * "kuru-ob-v2" is "Kuru OB V2".
 */
const marketNames = cached(24 * 60 * 60_000, async (chain) => {
  const url = new URL("https://ks-setting.kyberswap.com/api/v1/dexes");
  url.searchParams.set("chain", chain);
  url.searchParams.set("pageSize", "1000");
  const body = await fetchJson<{
    readonly data: { readonly dexes: readonly { readonly dexId: string; readonly name: string }[] };
  }>(url, { timeoutMs: 5_000 });
  return new Map(body.data.dexes.map(({ dexId, name }) => [dexId, name]));
});

/** A market as people know it, without the version or kind KyberSwap adds: "Kuru OB V2" is Kuru. */
export function marketName(name: string): string {
  return name.replace(/(\s+(V\d+(\.\d+)?|OB|LB))+$/iu, "").trim() || name;
}

/**
 * The markets a route fills on, as people know them; a market KyberSwap names nowhere is left
 * out, and so are all of them while its names can't be read, since an id ("kuru-ob-v2") is no
 * name. The names only dress the card and Activity: what fills is what the route's bytes say.
 */
async function filledOn(chain: string, ids: readonly string[]): Promise<string[]> {
  const names = await marketNames(chain).catch(() => new Map<string, string>());
  return [...new Set(ids.flatMap((id) => (names.has(id) ? [marketName(names.get(id)!)] : [])))];
}

async function kyberQuote(request: EvmQuoteRequest): Promise<EvmRoute | null> {
  const base = `https://aggregator-api.kyberswap.com/${request.chain}/api/v1`;
  const headers = { "x-client-id": "auni" };
  const url = new URL(`${base}/routes`);
  url.searchParams.set("tokenIn", request.sellToken);
  url.searchParams.set("tokenOut", request.buyToken);
  url.searchParams.set("amountIn", request.sellAmount.toString());
  const routes = await fetchJson<KyberRouteResponse>(url, { timeoutMs: 8_000, init: { headers } });
  if (!routes.data) return null;
  const summary = routes.data.routeSummary;
  const markets = await filledOn(
    request.chain,
    summary.route.flat().map((leg) => leg.exchange),
  );
  const minBuy = (amount: bigint) => slippageFloor(amount, request.slippageBps);
  if (!request.taker) {
    const buyAmount = BigInt(summary.amountOut);
    return {
      provider: "KyberSwap",
      buyAmount,
      minBuyAmount: minBuy(buyAmount),
      filledOn: markets,
    };
  }
  const built = await fetchJson<KyberBuildResponse>(`${base}/route/build`, {
    timeoutMs: 8_000,
    init: {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        routeSummary: summary,
        sender: request.taker,
        recipient: request.taker,
        slippageTolerance: request.slippageBps,
      }),
    },
  });
  const buyAmount = BigInt(built.data.amountOut);
  const router = getAddress(built.data.routerAddress);
  const route: EvmRoute = {
    provider: "KyberSwap",
    buyAmount,
    minBuyAmount: minBuy(buyAmount),
    filledOn: markets,
    spender: router,
    transaction: {
      to: router,
      data: built.data.data as Hex,
      value: BigInt(built.data.transactionValue),
    },
  };
  return { ...route, send: (wallets) => sendEvmSwap(wallets, request, route) };
}

/** KyberSwap's route for any pair on an EVM cash chain. */
export async function quoteKyberSwap(request: EvmQuoteRequest): Promise<EvmRoute> {
  const route = await kyberQuote(request).catch(() => null);
  if (!route)
    throw new Error(`No swap route on ${NETWORKS[request.chain].name} for this pair and size.`);
  return route;
}
