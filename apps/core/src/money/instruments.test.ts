import { address, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionPreview } from "./recipe.ts";
import type { SolanaToken } from "../apps/contract.ts";

// No venue finds anything of its own: these tests are the stocks and tokens.
vi.mock("../apps/registry.ts", () => ({
  offered: () => [],
  venues: () => [],
  filling: () => [{ about: { name: "Jupiter" } }],
}));
vi.mock("./swaps/solana-swap.ts", () => ({
  searchSolanaTokens: vi.fn(async () => []),
  solanaTokens: vi.fn(),
  solanaPrice: vi.fn(),
}));
vi.mock("./swaps/xstocks.ts", () => ({ xStockCatalog: vi.fn(), findXStock: vi.fn() }));
vi.mock("./recipes/stock-trade.ts", () => ({ previewMonadBuy: vi.fn() }));

const { searchInstruments } = await import("./instruments.ts");
const { solanaPrice, solanaTokens } = await import("./swaps/solana-swap.ts");
const { findXStock, xStockCatalog } = await import("./swaps/xstocks.ts");
const { previewMonadBuy } = await import("./recipes/stock-trade.ts");

const RKLB = address("XsRKLBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
const OKLO = address("XsJb1p4Ks6VFggq68JyMz7S3kdRfkqh4wA6EMyxi4DD");

function stock(ticker: string, name: string, mint: Address) {
  return {
    symbol: `${ticker}x`,
    name: `${name} xStock`,
    ticker,
    logoUrl: "",
    solanaMint: mint,
    evmAddress: null,
  };
}

function token(mint: Address, symbol: string, usdPrice: number): SolanaToken {
  return {
    mint,
    symbol,
    name: symbol,
    decimals: 8,
    tokenProgram: mint,
    usdPrice,
    liquidityUsd: 50,
    volume24hUsd: 10,
    logoUrl: null,
    verified: true,
    organicScore: 1,
    tags: ["xstocks", "stocks"],
  };
}

function buy(costs: ActionPreview["effect"]["costs"], unpriced?: "loses on fill"): ActionPreview {
  return {
    summary: "Buy",
    amountUsd: "25",
    effect: { gives: [], gets: [], grants: [], costs },
    ...(unpriced ? { unpriced } : {}),
  };
}

beforeEach(() => {
  const catalog = [stock("RKLB", "Rocket Lab", RKLB), stock("OKLO", "Oklo", OKLO)];
  vi.mocked(xStockCatalog).mockResolvedValue(catalog);
  vi.mocked(findXStock).mockImplementation(async (symbol) =>
    catalog.find((s) => s.symbol === symbol)!,
  );
  // Searched by mint, as findStocks does; the tokens last swapped off their shares' prices.
  vi.mocked(solanaTokens).mockImplementation(async (mints) =>
    [token(RKLB, "RKLBx", 55), token(OKLO, "OKLOx", 27.04)].filter(({ mint }) =>
      mints.includes(mint),
    ),
  );
  vi.mocked(solanaPrice).mockImplementation(async (mint) => ({
    usdPrice: mint === RKLB ? 56.1 : 25.96,
    multiplier: 1,
  }));
});

describe("find_instruments", () => {
  it("says what $25 of each stock costs on Monad, and which Monad can't sell", async () => {
    vi.mocked(previewMonadBuy).mockImplementation(async (found) => {
      if (found.ticker === "OKLO")
        throw new Error("KyberSwap: No swap route on Monad; Kuru: no book for this stock.");
      return buy([{ label: "price move", usd: 0.125 }]);
    });
    const { candidates } = await searchInstruments({ query: "space", related: ["RKLB", "OKLO"] });
    expect(candidates.filter(({ kind }) => kind === "stock")).toEqual([
      expect.objectContaining({
        ticker: "RKLB",
        chain: "monad",
        tool: "stock_trade",
        price: 56.1,
        monad: "$25 costs $0.13 to buy",
      }),
      expect.objectContaining({
        ticker: "OKLO",
        price: 25.96,
        monad:
          "Monad can't sell it now: KyberSwap: No swap route on Monad; Kuru: no book for this stock.",
      }),
    ]);
  });

  // Asked what stocks it could buy, the AI told a wallet with no Solana address that a stock
  // under $10 moves to Solana, which it can't.
  it("lists nothing only Solana trades for a wallet that can't move there, and says why", async () => {
    vi.mocked(xStockCatalog).mockResolvedValue([
      stock("OKLO", "Oklo", OKLO),
      { ...stock("RKLB", "Rocket Lab", RKLB), evmAddress: "0xabc" },
    ] as Awaited<ReturnType<typeof xStockCatalog>>);
    vi.mocked(previewMonadBuy).mockResolvedValue(buy([]));
    const { searchSolanaTokens } = await import("./swaps/solana-swap.ts");
    vi.mocked(searchSolanaTokens).mockClear();
    const found = await searchInstruments(
      { query: "space", related: ["RKLB", "OKLO"] },
      {
        solana: false,
      },
    );
    expect(found.candidates.map(({ ticker }) => ticker)).toEqual(["RKLB"]);
    expect(searchSolanaTokens).not.toHaveBeenCalled();
    expect(found).toMatchObject({
      note: "This wallet has no Solana address yet, so nothing can move on Solana. One can be added in Settings, under Wallet.",
    });
    // A wallet that can is told both, and no note.
    const both = await searchInstruments({ query: "space", related: ["RKLB", "OKLO"] });
    expect(both.candidates.map(({ ticker }) => ticker).toSorted()).toEqual(["OKLO", "RKLB"]);
    expect(both).not.toHaveProperty("note");
  });

  it("names a stock that trades on Monad alone, which has no token on Solana to ask about", async () => {
    const lilly = { ...stock("LLY", "Eli Lilly", RKLB), solanaMint: null, evmAddress: "0xabc" };
    vi.mocked(xStockCatalog).mockResolvedValue([lilly] as Awaited<
      ReturnType<typeof xStockCatalog>
    >);
    vi.mocked(findXStock).mockResolvedValue(lilly as Awaited<ReturnType<typeof findXStock>>);
    vi.mocked(previewMonadBuy).mockResolvedValue(buy([]));
    vi.mocked(solanaTokens).mockClear();
    const { candidates } = await searchInstruments({ query: "Eli Lilly" });
    expect(candidates).toEqual([
      expect.objectContaining({ ticker: "LLY", chain: "monad", monad: "$25 costs nothing to buy" }),
    ]);
    expect(solanaTokens).not.toHaveBeenCalled();
  });

  it("says when Monad was too slow to price a stock, rather than that it can't sell it", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(previewMonadBuy).mockReturnValue(new Promise(() => {}));
      const search = searchInstruments({ query: "Rocket Lab" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await search).candidates[0]).toMatchObject({
        monad: "Monad didn't answer in time; stock_trade asks it again",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a stock Monad trades even where nothing trades it on Solana", async () => {
    // As RKLBx on 2026-10-30: no depth on Solana, $25 fair on Monad.
    vi.mocked(xStockCatalog).mockResolvedValue([
      {
        ...stock("RKLB", "Rocket Lab", RKLB),
        evmAddress: "0x0000000000000000000000000000000000000001",
      },
    ]);
    vi.mocked(findXStock).mockResolvedValue({
      ...stock("RKLB", "Rocket Lab", RKLB),
      evmAddress: "0x0000000000000000000000000000000000000001",
    });
    vi.mocked(solanaTokens).mockResolvedValue([
      { ...token(RKLB, "RKLBx", 55), liquidityUsd: null },
    ]);
    vi.mocked(previewMonadBuy).mockResolvedValue(buy([{ label: "price move", usd: 0.125 }]));
    const { candidates } = await searchInstruments({ query: "Rocket Lab" });
    expect(candidates).toEqual([
      expect.objectContaining({
        ticker: "RKLB",
        chain: "monad",
        price: 56.1,
        monad: "$25 costs $0.13 to buy",
      }),
    ]);
  });

  it("says when a stock costs more than a normal trade to buy on Monad", async () => {
    vi.mocked(previewMonadBuy).mockResolvedValue(
      buy([{ label: "price move", usd: 1.4 }], "loses on fill"),
    );
    const { candidates } = await searchInstruments({ query: "Rocket Lab" });
    expect(candidates[0]).toMatchObject({
      monad: "$25 costs $1.40 to buy, more than a normal trade",
    });
  });
});
