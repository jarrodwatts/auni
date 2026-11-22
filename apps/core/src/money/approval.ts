import type { EvmChainKey } from "@auni/shared";
import { encodeFunctionData, erc20Abi, type Address } from "viem";

import { publicClient } from "./chains.ts";
import type { EvmTx } from "./recipe.ts";

/**
 * An approval letting `spender` take exactly `amount` of the wallet's `token`, as setup before the
 * move that spends it; null when it already may. Never unlimited: spent in the same batch, it
 * leaves nothing behind for the spender to pull later.
 */
export async function exactApproval(
  chain: EvmChainKey,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
): Promise<EvmTx | null> {
  const allowance = await publicClient(chain).readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  if (allowance >= amount) return null;
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    setup: true,
  };
}
