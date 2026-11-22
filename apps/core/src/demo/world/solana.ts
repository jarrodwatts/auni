import { NETWORKS } from "@auni/shared";

import { rpcHost } from "../home.ts";
import type { Asked, Service } from "../world.ts";

// The demo's Solana: what the owner's address holds, as a node tells it. The demo moves nothing
// there, so it is a balance sheet and no more.

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** What the owner's Solana address holds: its lamports, and each mint's raw units and decimals. */
export const solana = {
  lamports: 0n,
  tokens: new Map<string, { readonly units: bigint; readonly decimals: number }>(),
};

/** A slot roughly every 400 milliseconds, counted from the clock. */
const slot = () => Math.floor(Date.now() / 400);

function answer(method: string, params: readonly unknown[]): unknown {
  const context = { slot: slot() };
  switch (method) {
    case "getBalance":
      return { context, value: Number(solana.lamports) };
    case "getTokenAccountsByOwner": {
      const [, { programId }] = params as [string, { programId: string }];
      // Every token the demo owner holds is a classic SPL token.
      const held = programId === TOKEN_PROGRAM ? [...solana.tokens] : [];
      return {
        context,
        value: held.map(([mint, { units, decimals }]) => ({
          pubkey: mint,
          account: {
            data: {
              parsed: {
                info: {
                  mint,
                  tokenAmount: {
                    amount: units.toString(),
                    decimals,
                    uiAmountString: (Number(units) / 10 ** decimals).toString(),
                  },
                },
              },
            },
          },
        })),
      };
    }
    case "getSlot":
      return slot();
    // Nothing arrives by itself in a demo: what came in is in the database from the start.
    case "getSignaturesForAddress":
      return [];
    default:
      throw new Error(`The demo's Solana doesn't answer ${method}.`);
  }
}

/** Solana's node, as money/chains.ts asks it. */
export const solanaRpc: Service = {
  hosts: [rpcHost("solana")],
  answer({ body }: Asked) {
    const { id, method, params } = body as { id: unknown; method: string; params?: unknown[] };
    try {
      return { jsonrpc: "2.0", id, result: answer(method, params ?? []) };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: (error as Error).message } };
    }
  },
};

/** Solana's native USDC, which the wallet holds as cash. */
export const SOLANA_USDC_MINT = NETWORKS.solana.usdc;
