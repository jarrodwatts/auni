import { address } from "@solana/kit";
import { expect, vi } from "vitest";

import type { SolanaQuoteRequest, SolanaToken } from "../../apps/contract.ts";
import { holdsToCard } from "../../test/held-to-card.ts";
import { OWNER } from "../../test/wallets.ts";
import { APPROVED_SALE } from "../approved.ts";
import { SOLANA_USDC, solanaTokenBalance } from "../chains.ts";
import { landedEffect, simulateSolana } from "../solana-effect.ts";
import { parseUnits } from "../usd.ts";

// A wallet on Solana holding $1,000 of USDC and 1,000 XYZ at $2 each, which pays its own fees and
// holds the SOL for them, trading through one route. The route's bytes are opaque to Auni, so what
// they would do is what their simulation from the wallet says; `bytes` is how a route goes wrong.
const XYZ: SolanaToken = {
  mint: address("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
  symbol: "XYZ",
  name: "XYZ",
  decimals: 6,
  tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  usdPrice: 2,
  liquidityUsd: 1_000_000,
  volume24hUsd: null,
  logoUrl: null,
  verified: true,
  organicScore: 0.9,
  tags: [],
};

const world = vi.hoisted(() => ({
  xyzUsd: 2,
  held: new Map<string, bigint>(),
  bytes: "honest" as "honest" | "pay a stranger" | "take more",
  built: [] as { request: SolanaQuoteRequest & { taker: string }; tx: string }[],
}));

/** The one Solana route, which trades XYZ at `world.xyzUsd`. */
const route = vi.hoisted(() => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const quote = (request: SolanaQuoteRequest) => {
    // USDC and XYZ both have 6 decimals, so the price converts base units directly.
    const amount = Number(request.amount);
    const outAmount = BigInt(
      Math.floor(request.inputMint === USDC_MINT ? amount / world.xyzUsd : amount * world.xyzUsd),
    );
    return {
      inAmount: request.amount,
      outAmount,
      minOutAmount: (outAmount * BigInt(10_000 - request.slippageBps)) / 10_000n,
      priceImpactPct: 0.1,
      route: "A pool",
    };
  };
  return {
    token: null as SolanaToken | null,
    quote: async (request: SolanaQuoteRequest) => quote(request),
    quoteNow: quote,
    search: async () => [{ ...route.token!, usdPrice: world.xyzUsd }],
    tokens: async () => [],
    price: async () => ({ usdPrice: world.xyzUsd, multiplier: 1 }),
    build: async (request: SolanaQuoteRequest & { taker: string }) => {
      const tx = Buffer.from(`swap ${world.built.length}`).toString("base64");
      world.built.push({ request, tx });
      return { quote: quote(request), transactionBase64: tx };
    },
  };
});
route.token = XYZ;

vi.mock(import("../../apps/registry.ts"), async (original) => ({
  ...(await original()),
  filling: ((kind: string) =>
    kind === "solana"
      ? [{ about: { id: "test-route", name: "Test Route" }, part: route }]
      : []) as never,
}));
vi.mock(import("../chains.ts"), async (original) => ({
  ...(await original()),
  solanaTokenBalance: vi.fn(),
}));
vi.mock(import("../solana-effect.ts"), async (original) => ({
  ...(await original()),
  landedEffect: vi.fn(),
  simulateSolana: vi.fn(),
}));
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  solanaAddress: async () => (await import("../../test/wallets.ts")).OWNER.solana,
  paysOwnGas: async () => true,
}));

/** The swap the route built last, which is what was simulated or sent, and what it pays out. */
function lastSwap() {
  const { request } = world.built.at(-1)!;
  return { request, outAmount: route.quoteNow(request).outAmount };
}

const buy = (more: Record<string, unknown>) => ({ token: "XYZ", side: "buy", ...more });
const sell = (more: Record<string, unknown>) => ({ token: "XYZ", side: "sell", ...more });

holdsToCard("solana_swap", {
  world() {
    world.xyzUsd = 2;
    world.bytes = "honest";
    world.built = [];
    world.held = new Map([
      [SOLANA_USDC.mint, parseUnits("1000", 6)],
      [XYZ.mint, parseUnits("1000", 6)],
    ]);
    vi.mocked(solanaTokenBalance).mockImplementation(async (_, mint) => world.held.get(mint) ?? 0n);
    vi.mocked(simulateSolana).mockImplementation(async () => {
      const { request, outAmount } = lastSwap();
      const taken = world.bytes === "take more" ? request.amount * 2n : request.amount;
      return {
        effect: {
          out: [{ token: request.inputMint, amount: taken }],
          in:
            world.bytes === "pay a stranger"
              ? []
              : [{ token: request.outputMint, amount: outAmount }],
          grants: [],
        },
        fee: 5_000n,
        rent: 0n,
        short: 0n,
        position: null,
        app: null,
      } as never;
    });
    vi.mocked(landedEffect).mockImplementation(async () => {
      const { request, outAmount } = lastSwap();
      return {
        out: [{ token: request.inputMint, amount: request.amount }],
        in: [{ token: request.outputMint, amount: outAmount }],
        grants: [],
      } as never;
    });
  },
  asShown: {
    "a buy of $100 of XYZ": buy({ amountUsd: 100 }),
    "a sale of 200 XYZ": sell({ tokenAmount: 200 }),
  },
  paysAsShown(signed, card) {
    // It sends the one swap the pinned route built for the owner's wallet, sized inside the card.
    expect(signed.solana).toEqual([{ base64Tx: world.built.at(-1)!.tx, setup: false }]);
    const { request } = world.built.at(-1)!;
    expect(request.taker).toBe(OWNER.solana);
    const most =
      card.input.side === "buy"
        ? (parseUnits(card.amountUsd, 6) * 10_100n) / 10_000n
        : parseUnits(card.details[APPROVED_SALE]!, 6);
    expect(request.amount).toBeLessThanOrEqual(most);
    expect(request.outputMint).toBe(card.input.side === "buy" ? XYZ.mint : SOLANA_USDC.mint);
  },
  priceMoved: {
    "a buy, once XYZ costs 3% more": {
      input: buy({ amountUsd: 100 }),
      after: () => {
        world.xyzUsd = 2.06;
      },
    },
    "a sale, once XYZ is worth 3% less": {
      input: sell({ tokenAmount: 200 }),
      after: () => {
        world.xyzUsd = 1.94;
      },
    },
  },
  takesMore: {
    "a buy of 50 XYZ, once each costs 5% more USDC": {
      input: buy({ tokenAmount: 50 }),
      after: () => {
        world.xyzUsd = 2.1;
      },
    },
    "a sale of $100 of XYZ, once each is worth 5% less, so it takes more of them": {
      input: sell({ amountUsd: 100 }),
      after: () => {
        world.xyzUsd = 1.9;
      },
    },
    "a sale of all its XYZ, once more arrived after the card": {
      input: sell({}),
      after: () => {
        world.held.set(XYZ.mint, parseUnits("1500", 6));
      },
    },
  },
  paysElsewhere: {
    "the route's bytes send what it buys to someone else": {
      input: buy({ amountUsd: 100 }),
      after: () => {
        world.bytes = "pay a stranger";
      },
    },
    "the route's bytes take more from the wallet than the trade": {
      input: buy({ amountUsd: 100 }),
      after: () => {
        world.bytes = "take more";
      },
    },
  },
});
