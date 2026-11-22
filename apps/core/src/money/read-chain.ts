import { z } from "zod";

import { turnCallCounter } from "../auth/turn-token-middleware.ts";
import { defineTool, failure, result } from "../agent/tool.ts";
import { evmClient } from "./chains.ts";

// Far above what a turn's reads should need; a keyed RPC is shared by everything Auni does.
const readsAllowed = turnCallCounter(1_000, "chain reads");
// Far above what one batch of reads should hold.
export const MAX_BATCH = 100;

/**
 * What the agent reads a chain for (balances, allowances, decimals, whether an address is a
 * contract, how a transaction went), and nothing else. A method that costs the provider far more
 * (traces, logs, transfer histories) would let one turn spend the key's allowance, and the agent
 * signs nothing, so it has nothing to send.
 */
const READ_METHODS = [
  "eth_blockNumber",
  "eth_chainId",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
] as const;

/** The node's own words for a failed call ("execution reverted: ..."), not viem's category for it. */
function rpcError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { details, shortMessage } = error as { details?: unknown; shortMessage?: unknown };
  return String(details || shortMessage || error.message).split("\n")[0]!;
}

/**
 * Any EVM chain's JSON-RPC reads, through core's own RPC (its keyed URL never leaves core). A tool
 * rather than a URL, since the agent's shell can't reach this machine's ports, and every brain
 * reaches its tools the same way.
 */
export function readChainTool(turn: { readonly threadId: string; readonly turnStartedAt: string }) {
  return defineTool({
    name: "read_chain",
    description:
      "Read any EVM chain over JSON-RPC: balances, allowances, decimals, contract code, nonces, " +
      `transactions and receipts. Methods: ${READ_METHODS.join(", ")}. Up to ${MAX_BATCH} calls ` +
      "in one go; each answers with its `result` or its `error`.",
    inputSchema: {
      chainId: z.number().int().positive(),
      calls: z
        .array(z.object({ method: z.enum(READ_METHODS), params: z.array(z.unknown()).default([]) }))
        .min(1)
        .max(MAX_BATCH),
    },
    async handler({ chainId, calls }) {
      if (!readsAllowed(turn, calls.length))
        return failure("This turn has spent its chain reads; answer from what you have.");
      let client;
      try {
        client = evmClient(chainId);
      } catch (error) {
        return failure(error);
      }
      const answers = await Promise.all(
        calls.map(({ method, params }) =>
          client
            .request({ method, params } as never)
            .then((found: unknown) => ({ result: found }))
            .catch((error: unknown) => ({ error: rpcError(error) })),
        ),
      );
      return result(JSON.stringify(answers));
    },
  });
}
