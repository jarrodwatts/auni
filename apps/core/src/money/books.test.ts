import { describe, expect, it } from "vitest";

import { savingsTokens } from "../apps/registry.ts";
import {
  buildPortfolio,
  holdersOf,
  holdingsOfThread,
  ownedMoveFills,
  saleOwners,
  sharedFill,
  type PotFill,
} from "./books.ts";
import { QUANTITY_DECIMALS } from "./fill-key.ts";
import { madeUsd } from "./made.ts";
import type { Holding } from "./portfolio.ts";
import { plainCashUsd } from "./readings.ts";
import { parseUnits } from "./usd.ts";

const fill = (
  side: "buy" | "sell",
  quantity: string,
  usdValue: string,
  instrument = "nvda",
  chain = "solana",
): PotFill => ({ chain, instrument, side, quantity, usdValue });

describe("buildPortfolio", () => {
  describe("cash orders hold", () => {
    const usdc = (usdValue: string, heldForOrders?: true): Holding => ({
      venue: "hyperliquid",
      chain: "hyperliquid",
      instrument: "USDC",
      symbol: "USDC",
      quantity: usdValue,
      decimals: 6,
      usdValue,
      cash: true,
      priceId: null,
      ...(heldForOrders ? { heldForOrders } : {}),
    });
    // The account in live use while a $11 order at 3x waited: $0.92 free, $3.54 held for it.
    const read = (holdings: readonly Holding[]) =>
      buildPortfolio({
        observedAt: new Date(),
        holdings,
        onItsWay: [],
        unavailable: [],
        looking: [],
      });

    it("counts in the total, beside Cash rather than in it, so it is never offered to spend", () => {
      const portfolio = read([usdc("0.92"), usdc("3.54", true)]);
      expect(portfolio.totalUsd).toBe("4.46");
      expect(portfolio.cash.usdValue).toBe("0.92");
      expect(portfolio.assets.holdings).toEqual([usdc("3.54", true)]);
    });

    it("makes nothing and loses nothing when an order is placed: it is cash still", () => {
      const made = (holdings: readonly Holding[]) => {
        const portfolio = read(holdings);
        return madeUsd(Number(portfolio.totalUsd), plainCashUsd(portfolio), []);
      };
      expect(made([usdc("4.46")])).toBe("0.00");
      expect(made([usdc("0.92"), usdc("3.54", true)])).toBe("0.00");
    });
  });
});

describe("holdingsOfThread", () => {
  const btcShort: Holding = {
    venue: "hyperliquid",
    chain: "hyperliquid",
    instrument: "BTC",
    symbol: "BTC",
    quantity: "0.00023",
    decimals: 18,
    usdValue: "7.23",
    cash: false,
    priceId: null,
    short: true,
  };

  it("attributes a short to the thread whose sell opened it, never to a buyer", () => {
    const sellFill = {
      threadId: "btc",
      chain: "hyperliquid",
      instrument: "BTC",
      side: "sell" as const,
      quantity: "0.00023",
    };
    const buyFill = { ...sellFill, side: "buy" as const };
    expect(holdingsOfThread("btc", [btcShort], [sellFill])).toEqual([btcShort]);
    expect(holdingsOfThread("btc", [btcShort], [buyFill])).toEqual([]);
  });
});

describe("ownedMoveFills", () => {
  const savings = (side: "buy" | "sell", amount: string) =>
    fill(side, amount, amount, savingsTokens("monad")[0]!.token, "monad");

  it("keeps savings taken out to pay for picks outside a thread that held none", () => {
    const [withdrawn] = ownedMoveFills([savings("sell", "11.02628")], "thread-a", []);
    expect(withdrawn?.threadId).toBeNull();
  });

  it("gives a thread the savings it put in, and the owner the rest", () => {
    const [owned, rest] = ownedMoveFills([savings("sell", "30")], "thread-a", [
      savings("buy", "20"),
    ]);
    expect(owned).toMatchObject({ quantity: "20", usdValue: "20.00", threadId: "thread-a" });
    expect(rest).toMatchObject({ quantity: "10", usdValue: "10.00", threadId: null });
    expect(ownedMoveFills([savings("sell", "5")], "thread-a", [savings("buy", "20")])).toEqual([
      { ...savings("sell", "5"), threadId: "thread-a" },
    ]);
  });
});

describe("saleOwners and sharedFill", () => {
  const units = (quantity: string) => parseUnits(quantity, QUANTITY_DECIMALS);
  const ownedSaleFills = (
    sold: PotFill,
    place: string | null,
    holders: Parameters<typeof saleOwners>[2],
  ) => sharedFill(sold, saleOwners(units(sold.quantity), place, holders));
  // The wallet held 11 NVIDIA: 10 of them "ai"'s and 1 unattributed.
  const held = { threads: [["ai", units("10")] as const], other: units("1") };
  const sale = (quantity: string) => fill("sell", quantity, "40");

  it("writes an unattributed sale to other while other held enough", () => {
    expect(ownedSaleFills(sale("1"), null, held)).toEqual([{ ...sale("1"), threadId: null }]);
  });

  it("writes a sale past other's share to the thread whose holding it sold", () => {
    const pieces = ownedSaleFills(sale("4"), null, held);
    expect(pieces).toMatchObject([
      { threadId: null, quantity: "1", usdValue: "10.00" },
      { threadId: "ai", quantity: "3", usdValue: "30.00" },
    ]);
  });

  it("takes from the thread that sold first, then other, then the others", () => {
    const three = {
      threads: [["ai", units("2")] as const, ["chips", units("5")] as const],
      other: units("1"),
    };
    expect(ownedSaleFills(sale("2"), "ai", three)).toEqual([{ ...sale("2"), threadId: "ai" }]);
    expect(
      ownedSaleFills(sale("4"), "ai", three).map(({ threadId, quantity }) => [threadId, quantity]),
    ).toEqual([
      ["ai", "2"],
      [null, "1"],
      ["chips", "1"],
    ]);
  });

  it("leaves what it sold past everything with the place that sold, as an oversold sale was", () => {
    const pieces = ownedSaleFills(sale("13"), "ai", held);
    expect(pieces.map(({ threadId, quantity }) => [threadId, quantity])).toEqual([
      ["ai", "12"],
      [null, "1"],
    ]);
  });

  it("sells a thread's own books first, even where the wallet falls short of everyone's", () => {
    // The wallet holds 6, but the books say 10: "chips" (first in order) 6, "ai" 4.
    const books = new Map([
      ["chips", new Map([["solana:nvda", units("6")]])],
      ["ai", new Map([["solana:nvda", units("4")]])],
    ]);
    expect(holdersOf(units("6"), books, "solana:nvda").threads).toEqual([["chips", units("6")]]);
    // Sold from "ai", it's ai's 4 that went, not the 6 chips holds.
    const heldByAi = holdersOf(units("6"), books, "solana:nvda", "ai");
    expect(saleOwners(units("4"), "ai", heldByAi)).toEqual([["ai", units("4")]]);
  });

  it("shares what a swap brought in by the same weights, so a swapped holding stays its thread's", () => {
    const owners = saleOwners(units("4"), null, held);
    const bought = fill("buy", "8", "40", "tsla");
    expect(
      sharedFill(bought, owners).map(({ threadId, quantity }) => [threadId, quantity]),
    ).toEqual([
      [null, "2"],
      ["ai", "6"],
    ]);
  });

  it("shares its dollars so the pieces add up to the whole exactly", () => {
    const odd = fill("sell", "3", "10");
    const thirds = { threads: [["ai", units("1")] as const], other: units("1") };
    const pieces = ownedSaleFills(odd, "chips", {
      ...thirds,
      threads: [...thirds.threads, ["chips", units("1")] as const],
    });
    const sum = pieces.reduce((total, piece) => total + parseUnits(piece.usdValue, 2), 0n);
    expect(sum).toBe(1000n);
  });
});
