import type { EvmChainKey } from "@auni/shared";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import type { Asked, Service } from "../world.ts";
import { chains, Reverted, type Contract } from "./chain.ts";
import { tokenAt, tokenUsd } from "./tokens.ts";

// The demo's swap route: KyberSwap's API (apps/kyberswap/kyberswap.ts), quoting any pair the
// demo lists at its prices less a small spread. It builds calls to KyberSwap's router at the
// router's real address, in the router's real `swap` shape, so its reader (apps/kyberswap/
// reader.ts) reads them as it reads the real ones. The demo's router does exactly what the bytes
// say: it takes what is sold, pays what the route quoted (carried in the executor's data, which
// only KyberSwap's executor reads on a real chain), and refuses to pay under the least the bytes
// allow, as the real one does. So what core's simulation reads before a card and what the chain
// does after the tap are the same.

/** KyberSwap's router, as its API names it on every chain (apps/kyberswap/fixtures/routers.json). */
const ROUTER: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const DESCRIPTION =
  "(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit)";
const ROUTER_ABI = parseAbi([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${DESCRIPTION} desc, bytes clientData) execution) payable returns (uint256, uint256)`,
]);
/** What the demo's executor data carries: what the route pays. */
const PAYS = parseAbiParameters("uint256 amountOut");
/** The market the demo's routes fill on, as KyberSwap's list of markets names it. */
const MARKET = { dexId: "kuru-ob-v2", name: "Kuru OB V2" };

/** What the route keeps of a trade, as a share of it. */
const SPREAD = 0.001;

let failing = false;

/** Has the router refuse the next trade it is asked to run, once: how a scene shows a failure. */
export function failNextSwap(): void {
  failing = true;
}

/** Takes the sold token from the caller and pays the bought one to the receiver the bytes name. */
const router: Contract = (call, chain) => {
  if (failing) {
    failing = false;
    throw new Reverted("the pool is paused");
  }
  const { args } = decodeFunctionData({ abi: ROUTER_ABI, data: call.data });
  const { desc, targetData } = args[0];
  const [pays] = decodeAbiParameters(PAYS, targetData);
  if (pays < desc.minReturnAmount) throw new Reverted("Return amount is not enough");
  chain.spend(desc.srcToken, call.from, ROUTER, desc.amount);
  // The router makes the market: it always has what it pays out.
  chain.credit(desc.dstToken, ROUTER, pays);
  return {
    returned: "0x",
    logs: [
      chain.move(desc.srcToken, call.from, ROUTER, desc.amount),
      chain.move(desc.dstToken, ROUTER, desc.dstReceiver, pays),
    ],
  };
};
for (const chain of chains.values()) chain.deploy(ROUTER, router);

interface Summary {
  readonly tokenIn: Address;
  readonly amountIn: string;
  readonly tokenOut: Address;
  readonly amountOut: string;
  readonly route: readonly (readonly { readonly exchange: string }[])[];
}

/** The route for selling `amountIn` of one listed token for another, at the demo's prices. */
function quote(chain: EvmChainKey, tokenIn: string, tokenOut: string, amountIn: bigint) {
  const sold = tokenAt(chain, tokenIn);
  const bought = tokenAt(chain, tokenOut);
  if (!sold || !bought) return null;
  const usd = (Number(amountIn) / 10 ** sold.decimals) * tokenUsd(sold) * (1 - SPREAD);
  const amountOut = BigInt(Math.floor((usd / tokenUsd(bought)) * 10 ** bought.decimals));
  return {
    tokenIn: sold.address,
    amountIn: amountIn.toString(),
    tokenOut: bought.address,
    amountOut: amountOut.toString(),
    route: [[{ exchange: MARKET.dexId }]],
  } satisfies Summary;
}

/** The router's call for a quoted route, paying `recipient` and failing under `slippageBps`. */
function built(trade: Summary, recipient: Address, slippageBps: number): Hex {
  const amountOut = BigInt(trade.amountOut);
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swap",
    args: [
      {
        callTarget: zeroAddress,
        approveTarget: zeroAddress,
        targetData: encodeAbiParameters(PAYS, [amountOut]),
        desc: {
          srcToken: trade.tokenIn,
          dstToken: trade.tokenOut,
          srcReceivers: [],
          srcAmounts: [],
          feeReceivers: [],
          feeAmounts: [],
          dstReceiver: recipient,
          amount: BigInt(trade.amountIn),
          minReturnAmount: (amountOut * BigInt(10_000 - slippageBps)) / 10_000n,
          flags: 0n,
          permit: "0x",
        },
        clientData: "0x",
      },
    ],
  });
}

/**
 * A swap through KyberSwap as Claude builds one by hand (apps/kyberswap/SKILL.md): its router's
 * call, built at 1% slippage, as a scene sends it with send_evm_transaction.
 */
export function kyberSwap(
  chain: EvmChainKey,
  sell: Address,
  buy: Address,
  amountIn: bigint,
  recipient: Address,
): { readonly to: Address; readonly data: Hex } {
  const trade = quote(chain, sell, buy, amountIn);
  if (!trade) throw new Error(`The demo lists no ${sell} or ${buy} on ${chain}.`);
  return { to: ROUTER, data: built(trade, recipient, 100) };
}

export const kyberswap: Service = {
  hosts: ["aggregator-api.kyberswap.com", "ks-setting.kyberswap.com"],
  answer({ url, body }: Asked) {
    if (url.hostname === "ks-setting.kyberswap.com")
      return url.pathname === "/api/v1/dexes" ? { data: { dexes: [MARKET] } } : undefined;
    const [chain, , , ...path] = url.pathname.split("/").filter(Boolean);
    if (!chains.has(chain as EvmChainKey)) return undefined;
    if (path.join("/") === "routes") {
      const routeSummary = quote(
        chain as EvmChainKey,
        url.searchParams.get("tokenIn") ?? "",
        url.searchParams.get("tokenOut") ?? "",
        BigInt(url.searchParams.get("amountIn") ?? 0),
      );
      // No data is KyberSwap's word for a pair it has no route for.
      return routeSummary ? { data: { routeSummary, routerAddress: ROUTER } } : {};
    }
    if (path.join("/") === "route/build") {
      const { routeSummary, recipient, slippageTolerance } = body as {
        routeSummary: Summary;
        recipient: Address;
        slippageTolerance?: number;
      };
      return {
        data: {
          amountOut: routeSummary.amountOut,
          data: built(routeSummary, recipient, slippageTolerance ?? 0),
          routerAddress: ROUTER,
          transactionValue: "0",
        },
      };
    }
    return undefined;
  },
};
