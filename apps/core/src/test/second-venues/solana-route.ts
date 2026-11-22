import { address } from "@solana/kit";
import { vi } from "vitest";

import { defineApp, type SolanaToken } from "../../apps/contract.ts";
import { ABOUT } from "./about.ts";

/** A second Solana route, listing one token at $2 and quoting what it's asked at that price. */
export const SOLANA_ROUTE = ABOUT.solanaRoute.id;

const FAKE_TOKEN: SolanaToken = {
  mint: address("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
  symbol: "FKS",
  name: "Fake Solana Token",
  decimals: 6,
  tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  usdPrice: 2,
  liquidityUsd: 1_000_000,
  volume24hUsd: 100_000,
  logoUrl: null,
  verified: true,
  organicScore: 0.9,
  tags: [],
};

const solanaQuote = vi.fn(
  async ({ amount, inputMint }: { readonly amount: bigint; readonly inputMint: string }) => {
    // USDC in buys half as many tokens; tokens in sell for twice as much USDC.
    const out = inputMint === FAKE_TOKEN.mint ? amount * 2n : amount / 2n;
    return {
      inAmount: amount,
      outAmount: out,
      minOutAmount: out,
      priceImpactPct: 0,
      route: "Fake Pool",
    };
  },
);

export default defineApp({
  about: ABOUT.solanaRoute,
  solana: {
    search: async () => [FAKE_TOKEN],
    tokens: async () => [FAKE_TOKEN],
    price: async () => ({ usdPrice: 2, multiplier: 1 }),
    quote: solanaQuote,
    build: async () => {
      throw new Error("A fake builds nothing.");
    },
  },
});
