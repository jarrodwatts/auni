import type { EvmChainKey } from "@auni/shared";
import { decodeFunctionData, isAddressEqual, parseAbi, type Address } from "viem";

import type { BuiltCall, Reading } from "../contract.ts";
import type { Simulated } from "../../money/wallet-effect.ts";
import about from "./about.ts";

// KyberSwap as a reader: a swap Claude routes through KyberSwap's API and sends itself with
// send_evm_transaction (SKILL.md) wears KyberSwap's name in the swap's layout, and says the one
// thing about it no simulation shows: how far the price may slip before the swap fails rather
// than fill.

/**
 * KyberSwap's router (MetaAggregationRouterV2), which every swap its API builds is sent to. The
 * API names the same address on each chain here (fixtures/routers.json, held by reader.test.ts).
 */
export const ROUTER: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

/** Auni's chains where KyberSwap's API answered with ROUTER; "bnb" is the one it calls "bsc". */
export const ROUTER_CHAINS: readonly EvmChainKey[] = [
  "monad",
  "base",
  "arbitrum",
  "polygon",
  "ethereum",
  "unichain",
  "bnb",
];

/** What some addresses are to the owner: KyberSwap's router, on the chains where it is. */
export async function addresses(chain: EvmChainKey): Promise<ReadonlyMap<string, string>> {
  return ROUTER_CHAINS.includes(chain)
    ? new Map([[ROUTER.toLowerCase(), `${about.name}'s router`]])
    : new Map();
}

// The swap a SwapDescriptionV2 says, as every way into the router carries it (the router's
// verified ABI): what is sold, what is bought, who gets it, and the least that must arrive.
const DESCRIPTION =
  "(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit)";
const ROUTER_ABI = parseAbi([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${DESCRIPTION} desc, bytes clientData) execution) payable returns (uint256, uint256)`,
  `function swapGeneric((address callTarget, address approveTarget, bytes targetData, ${DESCRIPTION} desc, bytes clientData) execution) payable returns (uint256, uint256)`,
  `function swapSimpleMode(address caller, ${DESCRIPTION} desc, bytes executorData, bytes clientData) returns (uint256, uint256)`,
]);

/** The swap one call to the router describes; null for any other call. */
function described(call: BuiltCall) {
  try {
    const { functionName, args } = decodeFunctionData({ abi: ROUTER_ABI, data: call.data });
    return functionName === "swapSimpleMode" ? args[1] : args[0].desc;
  } catch {
    return null;
  }
}

/** A percentage to one place, without a trailing ".0": "1", "0.5". */
const percent = (share: number) => String(Math.round(share * 1000) / 10);

/**
 * What a swap through KyberSwap's router reads as: the swap's layout, which titles it from what
 * the simulation saw leave and arrive, as on every card. The fine print says
 * the least the swap lets arrive (its minReturnAmount, which the router holds it to) as how far
 * below what the simulation got the price may slip, since the card's figures show only that.
 */
export function reads(
  _chain: EvmChainKey,
  calls: readonly BuiltCall[],
  seen: Simulated,
): Reading | null {
  // Core asks only of a batch that ends at the router (appFor in money/readers.ts).
  const swap = described(calls.at(-1)!);
  if (!swap) return null;
  const got = seen.in.find(({ token }) => isAddressEqual(token as Address, swap.dstToken));
  const slip =
    got && got.amount > 0n && swap.minReturnAmount <= got.amount
      ? 1 - Number((swap.minReturnAmount * 1_000_000n) / got.amount) / 1_000_000
      : null;
  // No title: the swap's layout names it from the simulation ("Sell ETH"), which says more.
  return {
    verb: "swap",
    ...(slip === null
      ? {}
      : {
          finePrint: `If the price slips more than ${percent(slip)}% before it goes through, the swap fails and only the network fee is spent.`,
        }),
  };
}
