import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { figureOf } from "../../test/recipe.ts";
import { effectLines } from "../effect.ts";
import type { Signer } from "../recipe.ts";
import { landedEffect, simulateSolana, type SolanaSimulation } from "../solana-effect.ts";
import type { SolanaQuote, SolanaToken } from "../../apps/contract.ts";
import { executeSolanaSwap, previewSolanaSwap, readBackSolanaSwap } from "./solana-swap.ts";
import { SOLANA_USDC, solanaTokenBalance } from "../chains.ts";
import { solForFees, topUpSol } from "../sol-top-up.ts";
import { pinnedSol } from "../../test/sol.ts";
import { feeCoinCash, feeCoinsSaid, feeCoinUsd } from "../fee-coin-said.ts";
import { paysOwnGas } from "../wallets.ts";

/** A Solana route of its own, and a second that quotes only where a test says. */
const { first, second, installed } = vi.hoisted(() => {
  const route = () => ({
    search: vi.fn(),
    tokens: vi.fn(),
    price: vi.fn(),
    quote: vi.fn(),
    build: vi.fn(),
  });
  return { first: route(), second: route(), installed: { routes: [] as unknown[] } };
});
vi.mock(import("../../apps/registry.ts"), async (original) => ({
  ...(await original()),
  filling: () => installed.routes as never,
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
// A wallet with a sponsor unless a test says it pays its own way; how SOL is bought for one that
// does is checked in sol-top-up.test.ts.
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  paysOwnGas: vi.fn(async () => false),
}));
vi.mock(import("../sol-top-up.ts"), async (original) => ({
  ...(await original()),
  // A dollar of Monad's USDC, sent to the pay-in service for SOL.
  solForFees: vi.fn(async () => (await import("../../test/sol.ts")).RELAYED_SOL),
  topUpSol: vi.fn(async () => [{ chain: "monad", hash: "0xrelay", setup: true as const }]),
}));

const xyz: SolanaToken = {
  mint: address("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
  symbol: "XYZ",
  name: "XYZ",
  decimals: 6,
  tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  usdPrice: null,
  liquidityUsd: null,
  volume24hUsd: null,
  logoUrl: null,
  verified: true,
  organicScore: 0.9,
  tags: [],
};

/** A quote paying `usdc` dollars for what's sold, its pool saying it moves the price only `impactPct`. */
function quoted(usdc: number, impactPct = 0.3): SolanaQuote {
  const out = BigInt(Math.round(usdc * 1e6));
  return {
    inAmount: 2_100_000_000_000n,
    outAmount: out,
    minOutAmount: (out * 99n) / 100n,
    priceImpactPct: impactPct,
    route: "Thin Pool",
  };
}

beforeEach(() => {
  installed.routes = [{ about: { id: "first", name: "First" }, part: first }];
  first.search.mockResolvedValue([xyz]);
  // 2.1M XYZ is worth $300 at the market's price.
  first.price.mockResolvedValue({ usdPrice: 300 / 2_100_000, multiplier: 1 });
});

const sale = { token: "XYZ", side: "sell", tokenAmount: 2_100_000 } as const;
const sell = () => previewSolanaSwap(sale, { owner: async () => "owner" });

describe("previewSolanaSwap", () => {
  // As "Buy 1 dollar of Palantir" did for a wallet brought with its EVM key alone: the route was
  // asked, refused for a setting's name, and the AI offered to connect it.
  it("says a wallet with no Solana address trades nothing there, asking no route", async () => {
    first.search.mockClear();
    first.quote.mockClear();
    await expect(
      previewSolanaSwap({ token: "XYZ", side: "buy", amountUsd: 1 }, { owner: async () => null }),
    ).rejects.toThrow(
      "This wallet has no Solana address yet, so nothing can move on Solana. One can be added in Settings, under Wallet.",
    );
    expect(first.search).not.toHaveBeenCalled();
    expect(first.quote).not.toHaveBeenCalled();
  });

  it("quotes every route and pins the one that gets the most", async () => {
    installed.routes.push({ about: { id: "second", name: "Second" }, part: second });
    first.quote.mockResolvedValue(quoted(290));
    second.quote.mockResolvedValue(quoted(297));
    const card = await sell();
    expect(card.details).toMatchObject({ venue: "Second", returnsUsd: "297.00" });
    // Searched and priced through the first route alone.
    expect(second.search).not.toHaveBeenCalled();
    expect(second.price).not.toHaveBeenCalled();
  });

  it("takes a route that quotes over one that can't, and names each reason when none can", async () => {
    installed.routes.push({ about: { id: "second", name: "Second" }, part: second });
    first.quote.mockRejectedValue(new Error("No route found."));
    second.quote.mockResolvedValue(quoted(297));
    expect((await sell()).details).toMatchObject({ venue: "Second" });
    second.quote.mockRejectedValue(new Error("Too thin"));
    await expect(sell()).rejects.toThrow("First: No route found; Second: Too thin.");
  });

  it("says in dollars what a sale loses at the market's price, however little its pool quotes", async () => {
    first.quote.mockResolvedValue(quoted(170));
    const card = await sell();
    expect(card.unpriced).toBe("loses on fill");
    expect(effectLines(card.effect)).toEqual([
      { label: "You give", value: "2,100,000 XYZ ($300)" },
      { label: "You get", value: "about $170 of USDC, at least $168.30" },
      { label: "Costs", value: "$130 price move" },
    ]);
    expect(figureOf(card, "Costs")).toBe("$130 price move");
  });

  // As $15 of SMRx did on 2026-10-30: a pool seeded with dust, quoting a small impact on its own price.
  it("says what a buy loses at the market's price, however little its pool quotes", async () => {
    // $15 buys 105,000 XYZ at the market's price; this pool gives 1,000, worth $0.14.
    first.quote.mockResolvedValue({
      ...quoted(0, 0.2),
      inAmount: 15_000_000n,
      outAmount: 1_000n * 10n ** BigInt(xyz.decimals),
      minOutAmount: 990n * 10n ** BigInt(xyz.decimals),
    });
    const card = await previewSolanaSwap(
      { token: "XYZ", side: "buy", amountUsd: 15 },
      { owner: async () => "owner" },
    );
    expect(card.unpriced).toBe("loses on fill");
    expect(figureOf(card, "Costs")).toBe("$14.86 price move");
  });

  it("lets a sale that fills near the market's price run on its own", async () => {
    first.quote.mockResolvedValue(quoted(297));
    const card = await sell();
    expect(card.unpriced).toBeUndefined();
    expect(card.details).toMatchObject({ getsAtLeast: "294.03" });
  });

  const OWNER = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";

  it("shows what buys the SOL a wallet paying its own way is short, as SOL for fees", async () => {
    vi.mocked(paysOwnGas).mockResolvedValueOnce(true);
    vi.mocked(solanaTokenBalance).mockResolvedValue(2_100_000_000_000n);
    first.quote.mockResolvedValue(quoted(297));
    first.build.mockResolvedValue({
      quote: quoted(297),
      transactionBase64: "built",
    });
    vi.mocked(simulateSolana).mockResolvedValueOnce({ short: 2_000_000n } as SolanaSimulation);
    const card = await previewSolanaSwap(sale, { owner: async () => OWNER });
    // The whole swap, which the wallet holds what it sells for.
    expect(simulateSolana).toHaveBeenCalledWith("built", address(OWNER), {});
    expect(solForFees).toHaveBeenCalledWith(2_000_000n, { spends: 0n });
    // The trade's figures and its lines both say only what it loses to fill; the dollar of SOL
    // is said as it is on an EVM chain, beside the move and never as a cost, since most of it
    // stays in the wallet.
    expect(figureOf(card, "Costs")).toBe("$3 price move");
    expect(effectLines(card.effect)).toContainEqual({ label: "Costs", value: "$3 price move" });
    // What execute spends on it, and no more.
    expect(card.details).toMatchObject(pinnedSol("1000000"));
    // Pinned as every purchase of a fee's coin is, so the same rules read it off this card: its
    // drawings say it, and it counts beside the move in a specialist's pot and a plan's sums.
    expect(feeCoinsSaid([{ details: card.details! }])).toBe(
      "Also buys about $1 of SOL for network fees, most of which stays in your wallet. Bought through Relay.",
    );
    expect(feeCoinUsd(card.details!)).toBe("1.00");
    expect(feeCoinCash(card.details!)).toEqual({ from: "monad", usd: "1.00" });
  });

  // As "buy 1 dollar of palantir" did on a Saturday, from a Solana address just added and
  // holding nothing: the whole swap failed its simulation for want of the USDC ("custom program
  // error: 0x1789"), so no card could put the buy behind the bridge that brings its cash.
  it.each([
    [
      "a buy whose cash isn't on Solana yet",
      { token: "XYZ", side: "buy", amountUsd: 1 },
      1_000_000n,
    ],
    ["a sale of what isn't held yet", sale, 0n],
  ] as const)(
    "makes the card of %s, from what its bytes open and pay without the swap",
    async (_, swap, spends) => {
      vi.mocked(paysOwnGas).mockResolvedValueOnce(true);
      vi.mocked(solanaTokenBalance).mockResolvedValue(0n);
      first.quote.mockResolvedValue(quoted(297));
      first.build.mockResolvedValue({ quote: quoted(297), transactionBase64: "built" });
      vi.mocked(simulateSolana).mockImplementationOnce(async (_bytes, _owner, options) => {
        // The whole swap can't run from a wallet without what it spends, as on chain.
        if (!options?.setupOnly) throw new Error("custom program error: 0x1789");
        return { short: 2_694_520n } as SolanaSimulation;
      });
      const card = await previewSolanaSwap(swap, { owner: async () => OWNER });
      expect(simulateSolana).toHaveBeenCalledWith("built", address(OWNER), { setupOnly: true });
      expect(solForFees).toHaveBeenCalledWith(2_694_520n, { spends });
      expect(card.details).toMatchObject(pinnedSol("1000000"));
    },
  );
});

// The route builds the swap's bytes, so they go only once a simulation shows them doing what was asked.
describe("executeSolanaSwap", () => {
  const OWNER = address("JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n");
  const approved = {
    amountUsd: "0",
    details: { mint: xyz.mint, getsAtLeast: "290", venue: "First" },
  };
  const simulation = (effect: SolanaSimulation["effect"]) =>
    ({ effect, fee: 5_000n, rent: 0n, short: 0n, position: null }) as SolanaSimulation;
  const send = vi.fn(async () => "signature");
  const wallets = { solanaAddress: OWNER, sendSolanaTransaction: send } as unknown as Signer;

  beforeEach(() => {
    send.mockClear();
    vi.mocked(solanaTokenBalance).mockResolvedValue(2_100_000_000_000n);
    first.build.mockResolvedValue({
      quote: quoted(297),
      transactionBase64: "built",
    });
    vi.mocked(landedEffect).mockResolvedValue({
      out: [{ token: xyz.mint, amount: 2_100_000_000_000n }],
      in: [{ token: SOLANA_USDC.mint, amount: 297_000_000n }],
      rent: 0n,
    });
  });

  it("sends a sale whose simulation sells what was asked and lands its cash in the wallet", async () => {
    vi.mocked(simulateSolana).mockResolvedValue(
      simulation({
        out: [{ token: xyz.mint, amount: 2_100_000_000_000n }],
        in: [{ token: SOLANA_USDC.mint, amount: 297_000_000n }],
        grants: [],
      }),
    );
    await executeSolanaSwap(sale, wallets, approved);
    expect(simulateSolana).toHaveBeenCalledWith("built", OWNER);
    expect(send).toHaveBeenCalledWith("built");
  });

  it("buys a wallet paying its own way the SOL it's short first, then builds the swap again", async () => {
    const sold = simulation({
      out: [{ token: xyz.mint, amount: 2_100_000_000_000n }],
      in: [{ token: SOLANA_USDC.mint, amount: 297_000_000n }],
      grants: [],
    });
    vi.mocked(simulateSolana)
      .mockResolvedValueOnce({ ...sold, short: 2_000_000n })
      .mockResolvedValueOnce(sold);
    first.build.mockClear();
    const result = await executeSolanaSwap(sale, wallets, approved);
    // Held to the card it runs on, which says what its SOL may cost (see sol-top-up.test.ts).
    expect(solForFees).toHaveBeenCalledWith(2_000_000n, { spends: 0n, approved });
    expect(topUpSol).toHaveBeenCalledWith(wallets, expect.objectContaining({ via: "pay-in" }));
    expect(first.build).toHaveBeenCalledTimes(2);
    expect(result.txs).toEqual([
      { chain: "monad", hash: "0xrelay", setup: true },
      { chain: "solana", hash: "signature" },
    ]);
  });

  it("sends no swap while the wallet is still short of SOL after buying some", async () => {
    vi.mocked(simulateSolana).mockResolvedValue({
      ...simulation({ out: [], in: [], grants: [] }),
      short: 2_000_000n,
    });
    await expect(executeSolanaSwap(sale, wallets, approved)).rejects.toThrow(
      "still short of SOL after buying some",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing whose simulation pays the cash out somewhere else", async () => {
    vi.mocked(simulateSolana).mockResolvedValue(
      simulation({ out: [{ token: xyz.mint, amount: 2_100_000_000_000n }], in: [], grants: [] }),
    );
    await expect(executeSolanaSwap(sale, wallets, approved)).rejects.toThrow(
      "It would get less into your wallet than was shown",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a sale whose price fell since its card only at a slippage that lands what the card said at least", async () => {
    // $297 expected; at the card's 1% the route would let $294.03 land, under its $296.
    first.build.mockImplementation(async ({ slippageBps }) => ({
      quote: {
        ...quoted(297),
        minOutAmount: (297_000_000n * BigInt(10_000 - slippageBps)) / 10_000n,
      },
      transactionBase64: "built",
    }));
    first.build.mockClear();
    vi.mocked(simulateSolana).mockResolvedValue(
      simulation({
        out: [{ token: xyz.mint, amount: 2_100_000_000_000n }],
        in: [{ token: SOLANA_USDC.mint, amount: 297_000_000n }],
        grants: [],
      }),
    );
    const card = {
      amountUsd: "0",
      details: { mint: xyz.mint, getsAtLeast: "296", venue: "First" },
    };
    await executeSolanaSwap(sale, wallets, card);
    const built = first.build.mock.calls.map(([request]) => request.slippageBps);
    expect(built).toEqual([100, 33]);
    const { quote } = await first.build.mock.results.at(-1)!.value;
    expect(quote.minOutAmount).toBeGreaterThanOrEqual(296_000_000n);
    expect(send).toHaveBeenCalledWith("built");
  });

  it("sends nothing once a sale's fresh quote expects less than its card said at least", async () => {
    const card = {
      amountUsd: "0",
      details: { mint: xyz.mint, getsAtLeast: "298", venue: "First" },
    };
    await expect(executeSolanaSwap(sale, wallets, card)).rejects.toThrow(
      "it would get less than was shown",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("builds on the route its card was quoted on, and on no other", async () => {
    installed.routes.push({ about: { id: "second", name: "Second" }, part: second });
    second.build.mockResolvedValue({ quote: quoted(297), transactionBase64: "second" });
    first.build.mockClear();
    vi.mocked(simulateSolana).mockResolvedValue(
      simulation({
        out: [{ token: xyz.mint, amount: 2_100_000_000_000n }],
        in: [{ token: SOLANA_USDC.mint, amount: 297_000_000n }],
        grants: [],
      }),
    );
    await executeSolanaSwap(sale, wallets, {
      ...approved,
      details: { ...approved.details, venue: "Second" },
    });
    expect(first.build).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("second");
  });

  it("sends nothing once the route its card was quoted on is gone", async () => {
    await expect(
      executeSolanaSwap(sale, wallets, {
        ...approved,
        details: { ...approved.details, venue: "Gone" },
      }),
    ).rejects.toThrow("isn't here any more");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing whose simulation leaves a delegate over the wallet's tokens", async () => {
    vi.mocked(simulateSolana).mockResolvedValue(
      simulation({
        out: [{ token: xyz.mint, amount: 2_100_000_000_000n }],
        in: [{ token: SOLANA_USDC.mint, amount: 297_000_000n }],
        grants: [{ kind: "spend", token: SOLANA_USDC.mint, to: "someone" }],
      }),
    );
    await expect(executeSolanaSwap(sale, wallets, approved)).rejects.toThrow("permission");
    expect(send).not.toHaveBeenCalled();
  });
});

// A run that stopped after its swap landed, before it read what arrived, is read back by reconcile.
describe("readBackSolanaSwap", () => {
  const owner = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const action = {
    details: { mint: xyz.mint },
    txs: [
      { chain: "monad", hash: "0xrelay", setup: true as const },
      { chain: "solana", hash: "swapped" },
    ],
  };
  const landed = (out: [string, bigint], into: [string, bigint]) =>
    vi.mocked(landedEffect).mockResolvedValue({
      out: [{ token: out[0], amount: out[1] }],
      in: [{ token: into[0], amount: into[1] }],
      rent: 0n,
    });

  it("reads a buy as what arrived for the USDC that left, from the swap itself", async () => {
    landed([SOLANA_USDC.mint, 300_000_000n], [xyz.mint, 2_100_000_000_000n]);
    expect(await readBackSolanaSwap(action, "buy", owner)).toEqual({
      fills: [
        {
          chain: "solana",
          instrument: xyz.mint,
          side: "buy",
          quantity: "2100000",
          usdValue: "300",
        },
      ],
    });
    expect(landedEffect).toHaveBeenLastCalledWith("swapped", owner);
  });

  it("reads a sell as what left for the USDC that arrived", async () => {
    landed([xyz.mint, 2_100_000_000_000n], [SOLANA_USDC.mint, 297_500_000n]);
    expect(await readBackSolanaSwap(action, "sell", owner)).toMatchObject({
      fills: [{ side: "sell", quantity: "2100000", usdValue: "297.5" }],
    });
  });

  it("never reads a set-up send as the swap, wherever it was kept", async () => {
    landed([SOLANA_USDC.mint, 300_000_000n], [xyz.mint, 2_100_000_000_000n]);
    const topUps = {
      ...action,
      txs: [
        { chain: "solana", hash: "topped-up", setup: true as const },
        { chain: "solana", hash: "swapped" },
        { chain: "solana", hash: "topped-up-again", setup: true as const },
      ],
    };
    await readBackSolanaSwap(topUps, "buy", owner);
    expect(landedEffect).toHaveBeenLastCalledWith("swapped", owner);
  });

  it("can't tell from a transaction that doesn't show both sides, or with nothing sent", async () => {
    landed([SOLANA_USDC.mint, 300_000_000n], [SOLANA_USDC.mint, 0n]);
    expect(await readBackSolanaSwap(action, "buy", owner)).toBeNull();
    expect(await readBackSolanaSwap({ ...action, txs: [] }, "buy", owner)).toBeNull();
    expect(await readBackSolanaSwap(action, "buy", null)).toBeNull();
  });
});
