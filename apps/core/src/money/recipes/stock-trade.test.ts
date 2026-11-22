import { NETWORKS } from "@auni/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { evmBalance, resolveEvmToken, type EvmRoute, type EvmToken } from "../swaps/evm.ts";
import { quoteStock } from "../swaps/routes.ts";
import { stockTrade } from "./stock-trade.ts";
import { findXStock, marketNote, type XStock } from "../swaps/xstocks.ts";
import { previewSolanaSwap, solanaPrice } from "../swaps/solana-swap.ts";
import { feeCoinsSaid, withFeeCoin, withoutFeeCoin } from "../fee-coin-said.ts";
import { costsLabel, costsTogether } from "../effect.ts";
import { buyingSolOnce, solForFees, withTopUp } from "../sol-top-up.ts";
import { asConversion } from "./convert.ts";

vi.mock(import("../swaps/xstocks.ts"), async (original) => ({
  ...(await original()),
  findXStock: vi.fn(),
  marketNote: vi.fn(),
}));
vi.mock(import("../swaps/routes.ts"), () => ({ quoteStock: vi.fn() }));
vi.mock(import("../swaps/evm.ts"), async (original) => ({
  ...(await original()),
  resolveEvmToken: vi.fn(),
  evmBalance: vi.fn(),
}));
vi.mock(import("../swaps/solana-swap.ts"), async (original) => ({
  ...(await original()),
  solanaPrice: vi.fn(),
  previewSolanaSwap: vi.fn(),
}));
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => "0x0000000000000000000000000000000000000002",
  solanaAddress: async () => "So11111111111111111111111111111111111111112",
  walletAddresses: async () => ({
    evm: "0x0000000000000000000000000000000000000002",
    solana: "So11111111111111111111111111111111111111112",
  }),
  // A wallet with a sponsor, which buys SOL by swapping its Solana USDC.
  paysOwnGas: async () => false,
}));
// The wallet's Solana USDC, and SOL at $100.
vi.mock(import("../chains.ts"), async (original) => ({
  ...(await original()),
  solanaTokenBalance: async () => 5_000_000n,
}));
vi.mock(import("../token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => 100,
}));

const nvda: XStock = {
  symbol: "NVDAx",
  name: "NVIDIA xStock",
  ticker: "NVDA",
  logoUrl: "https://example.com/NVDA.png",
  solanaMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  evmAddress: "0x0000000000000000000000000000000000000a11",
};
const usdc: EvmToken = { address: NETWORKS.monad.usdc, symbol: "USDC", decimals: 6, usdPrice: 1 };
const nvdax: EvmToken = {
  address: nvda.evmAddress!,
  symbol: "NVDAx",
  decimals: 18,
  usdPrice: null,
};
const noRoute = "KyberSwap: No swap route on Monad for this pair and size.";
const closed = " Backed lists NVDA's market as closed until Sun, 25 Oct 2026 00:00:00 GMT.";

const describeTrade = (trade: Parameters<typeof stockTrade.describe>[0]) =>
  stockTrade.describe(trade, {});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findXStock).mockResolvedValue(nvda);
  vi.mocked(marketNote).mockResolvedValue("");
  vi.mocked(solanaPrice).mockResolvedValue({ usdPrice: 200, multiplier: 1 });
  vi.mocked(resolveEvmToken).mockImplementation(async (_, token) =>
    token === "USDC" ? usdc : nvdax,
  );
  vi.mocked(evmBalance).mockResolvedValue(0n);
  vi.mocked(quoteStock).mockRejectedValue(new Error(noRoute));
  vi.mocked(previewSolanaSwap).mockResolvedValue({
    summary: "Swap on Solana",
    amountUsd: "25.00",
    effect: { gives: [], gets: [], grants: [] },
    details: { chain: "solana", returnsUsd: "25.00" },
  });
});

describe("stock_trade's preview", () => {
  it("trades on Monad when a venue there quotes it", async () => {
    const route: EvmRoute = {
      provider: "KyberSwap",
      buyAmount: 124n * 10n ** 15n,
      minBuyAmount: 123n * 10n ** 15n,
    };
    vi.mocked(quoteStock).mockResolvedValue(route);
    const card = await describeTrade({ stock: "NVDA", side: "buy", amountUsd: 25 });
    expect(card.details).toMatchObject({ chain: "monad", stock: "NVDAx" });
    expect(card.details?.note).toBeUndefined();
    expect(card.card).toMatchObject({ price: "$200.00" });
  });

  // The agent offers the most helpful path from what Monad answered, so the card carries it.
  it("moves a buy Monad can't take to Solana, saying what Monad answered and when it reopens", async () => {
    vi.mocked(marketNote).mockResolvedValue(closed);
    const card = await describeTrade({ stock: "NVDA", side: "buy", amountUsd: 25 });
    expect(card.details).toMatchObject({
      chain: "solana",
      note: `On Monad: ${noRoute}${closed} So this trades on Solana with USDC there.`,
    });
  });

  it("gives that answer as the error when the trade is pinned to Monad", async () => {
    await expect(
      describeTrade({ stock: "NVDA", side: "buy", amountUsd: 25, chain: "monad" }),
    ).rejects.toThrow(`NVDAx can't trade on Monad now: ${noRoute}`);
    expect(previewSolanaSwap).not.toHaveBeenCalled();
  });

  it("keeps a buy that costs more than usual on Monad, where its card says the cost", async () => {
    // $25 for 0.12 NVDAx at $200 is $24: 4% lost the moment it fills.
    vi.mocked(quoteStock).mockResolvedValue({
      provider: "KyberSwap",
      buyAmount: 12n * 10n ** 16n,
      minBuyAmount: 12n * 10n ** 16n,
    });
    const card = await describeTrade({ stock: "NVDA", side: "buy", amountUsd: 25 });
    expect(card.details).toMatchObject({ chain: "monad" });
    expect(card.unpriced).toBe("loses on fill");
    expect(card.effect.costs).toEqual([{ label: "price move", usd: 1 }]);
    expect(previewSolanaSwap).not.toHaveBeenCalled();
  });

  it("values a Monad token as one share, however far dividends grew its multiplier", async () => {
    // $25 of NVDAx at $200: a fair fill, at a 1.05 multiplier too.
    vi.mocked(solanaPrice).mockResolvedValue({ usdPrice: 200, multiplier: 1.05 });
    vi.mocked(quoteStock).mockResolvedValue({
      provider: "KyberSwap",
      buyAmount: 125n * 10n ** 15n,
      minBuyAmount: 125n * 10n ** 15n,
    });
    const card = await describeTrade({ stock: "NVDA", side: "buy", amountUsd: 25 });
    expect(card.unpriced).toBeUndefined();
    expect(card.effect.costs).toEqual([]);
  });

  it("sells shares the Monad wallet doesn't hold where they are, without asking Monad's venues", async () => {
    const card = await describeTrade({ stock: "NVDA", side: "sell", shares: 2 });
    expect(card.details).toMatchObject({ chain: "solana" });
    expect(card.details?.note).toContain("Only 0 NVDAx on Monad, 2 needed.");
    expect(quoteStock).not.toHaveBeenCalled();
  });

  it("keeps what Monad answered when Solana can't take it either", async () => {
    vi.mocked(previewSolanaSwap).mockRejectedValue(new Error("No NVDAx held on Solana to sell."));
    await expect(describeTrade({ stock: "NVDA", side: "sell" })).rejects.toThrow(
      "No NVDAx held on Solana to sell. On Monad: No NVDAx on Monad to sell.",
    );
  });
});

// As "buy 1 dollar of palantir" did live once more: bridges from Base and from Arbitrum into
// Solana, then this buy there, bought SOL twice ("$2 SOL for fees"), since the buy's card was
// made afresh from the swap's and left behind what its SOL was sized for, so the card couldn't
// buy it once for all of them.
describe("stock_trade on a card that buys SOL once", () => {
  /** What each move is short of SOL from a wallet with none: opening USDC's account, then the stock's. */
  const OPENS = 2_694_520n;
  const BUYS = 2_214_800n;
  const bridge = async (summary: string, eth: boolean) => {
    const sol = withTopUp(
      { summary, amountUsd: "1", effect: { gives: [], gets: [], grants: [] }, details: {} },
      await solForFees(OPENS),
    );
    const base = {
      chain: "base",
      from: "monad",
      token: NETWORKS.monad.usdc,
      amount: 250_000n,
      usd: 0.25,
      by: "Relay",
    } as const;
    return { stage: 1, preview: eth ? withFeeCoin(withoutFeeCoin(sol), base) : sol };
  };

  it("keeps the SOL its Solana swap buys, so the card buys it once", async () => {
    const swap = withTopUp(
      {
        summary: "Buy about $1 of Palantir on Solana",
        amountUsd: "1.00",
        effect: { gives: [{ text: "$1 of USDC" }], gets: [], grants: [] },
        details: { chain: "solana" },
      },
      await solForFees(BUYS, { spends: 1_000_000n }),
    );
    vi.mocked(previewSolanaSwap).mockResolvedValue(swap);
    const buy = await describeTrade({ stock: "PLTR", side: "buy", amountUsd: 1 });
    expect(buy.details).toMatchObject({ chain: "solana", feeCoinOn: "solana" });
    expect(buy.buysSol).toEqual({ lamports: BUYS, spends: 1_000_000n });

    const legs = [
      await bridge("Move $0.99 from Base to Solana", true),
      await bridge("Move $0.60 from Arbitrum to Solana", false),
      { stage: 3, preview: buy },
    ];
    const [fromBase, fromArbitrum, palantir] = await buyingSolOnce(legs, ({ stage }) => stage);
    expect(fromBase!.preview.details).toMatchObject({ feeCoinOn: "base" });
    expect(fromArbitrum!.preview.details).toMatchObject({
      feeCoinOn: "solana",
      feeCoinAhead: "yes",
    });
    expect(palantir!.preview.details).not.toHaveProperty("feeCoinOn");
    const previews = [fromBase!, fromArbitrum!, palantir!].map(({ preview }) => preview);
    // Once: what buys SOL for opening two accounts and a buy, a tenth over, at $100. It and the
    // ETH are no cost, as what the fees don't use stays, so the card says them apart.
    expect(costsLabel(costsTogether(previews.map(({ effect }) => effect)))).toBeNull();
    expect(feeCoinsSaid(previews.map(({ details }) => ({ details: details! })))).toBe(
"Also buys about $1.09 of ETH and SOL for network fees, most of which stays in your wallet. Bought through Relay and Jupiter.",
    );
  });

  it("is as true of a holding converted to cash on Solana", () => {
    const swap = withTopUp(
      {
        summary: "Sell 2 XYZ",
        amountUsd: "0",
        effect: { gives: [], gets: [], grants: [] },
        details: { sell: "2 XYZ", returnsUsd: "3.00", getsAtLeast: "2.97" },
      },
      {
        via: "swap",
        usdc: 300_000n,
        lamports: OPENS,
        spends: 0n,
        bought: {
          chain: "solana",
          from: "solana",
          token: NETWORKS.solana.usdc,
          amount: 300_000n,
          usd: 0.3,
          by: "Route",
        },
      },
    );
    expect(asConversion("solana", swap).buysSol).toEqual({ lamports: OPENS, spends: 0n });
  });
});
