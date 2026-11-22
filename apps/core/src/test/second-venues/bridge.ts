import { EVM_CASH_KEYS, type ActionToolName } from "@auni/shared";
import { vi } from "vitest";
import { z } from "zod";

import { defineApp } from "../../apps/contract.ts";
import type { Recipe, SentTx } from "../../money/recipe.ts";
import { ABOUT } from "./about.ts";

/** A second bridge, which lands all but ten cents of what it moves. */
export const BRIDGE = ABOUT.bridge.id;

const input = {
  from_chain: z.enum(EVM_CASH_KEYS),
  to_chain: z.enum(EVM_CASH_KEYS),
  amount: z.string(),
};

const bridgeUsdc: Recipe<typeof input> = {
  tool: "fake_bridge_usdc" as ActionToolName,
  description: "Move USDC between the owner's own chains through Fake Bridge.",
  input,
  venue: BRIDGE,
  fundedFrom: ({ input }) => input.from_chain,
  readies: (input) => input.to_chain,
  about: () => ({ kind: "cash", at: "wallet" }),
  async describe({ amount, from_chain }) {
    return {
      summary: `Move $${amount} from ${from_chain}`,
      amountUsd: amount,
      effect: { gives: [{ text: `$${amount} of USDC` }], gets: [], grants: [] },
    };
  },
  async execute() {
    throw new Error("A fake sends nothing.");
  },
};

export const bridgeQuote = vi.fn(async ({ amount }: { readonly amount: string }) => ({
  expectedOutputAmount: String(Math.round(Number(amount) * 1e6) - 100_000),
}));

/** Its send, which sends nothing. */
export const bridgeSend = vi.fn(async (): Promise<{ readonly txs: readonly SentTx[] }> => {
  throw new Error("A fake sends nothing.");
});

export default defineApp({
  about: ABOUT.bridge,
  moves: [bridgeUsdc],
  bridge: {
    recipe: bridgeUsdc,
    input: ({ from, to, amount }) => ({ from_chain: from, to_chain: to, amount }),
    quote: bridgeQuote,
    send: bridgeSend,
  },
  addresses: async () =>
    new Map([["0x000000000000000000000000000000000000fb01", "a Fake Bridge bridge"]]),
});
