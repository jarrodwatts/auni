import { describe, expect, it } from "vitest";

import { savingsTokens } from "../apps/registry.ts";
import {
  attribute,
  holdersOf,
  holdingGaps,
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

describe("attribute", () => {
  const nvidia: Holding = {
    venue: "wallet",
    chain: "solana",
    instrument: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    symbol: "NVDAx",
    quantity: "0.01",
    decimals: 8,
    usdValue: "2.25",
    cash: false,
    priceId: null,
  };
  const fill = (specialistId: string, chain: string, instrument: string) => ({
    specialistId,
    chain,
    instrument,
    side: "buy" as const,
    quantity: "0.01",
  });
  /** Stocks bought on Solana, and a perp opened on Hyperliquid, whose read failed. */
  const split = (unread: (chain: string) => boolean) =>
    attribute({
      observedAt: new Date(),
      holdings: [nvidia],
      fills: [fill("stocks", "solana", nvidia.instrument), fill("perps", "hyperliquid", "BTC")],
      specialists: [
        { id: "stocks", purpose: "Chips", status: "active" },
        { id: "perps", purpose: "Bitcoin", status: "active" },
      ],
      onItsWay: [],
      unavailable: ["hyperliquid"],
      looking: [],
      unread,
    }).specialists.map(({ id, whole }) => [id, whole]);

  it("keeps a specialist whole while a venue it holds nothing on can't be read", () => {
    expect(split((chain) => chain === "hyperliquid")).toEqual([
      ["stocks", true],
      ["perps", false],
    ]);
  });

  it("keeps none whole when prices couldn't be read", () => {
    expect(split(() => true)).toEqual([
      ["stocks", false],
      ["perps", false],
    ]);
  });

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
      attribute({
        observedAt: new Date(),
        holdings,
        fills: [],
        specialists: [],
        onItsWay: [],
        unavailable: [],
        looking: [],
        unread: () => false,
      });

    it("counts in the total, beside Cash rather than in it, so it is never offered to spend", () => {
      const portfolio = read([usdc("0.92"), usdc("3.54", true)]);
      expect(portfolio.totalUsd).toBe("4.46");
      expect(portfolio.cash.usdValue).toBe("0.92");
      expect(portfolio.other.holdings).toEqual([usdc("3.54", true)]);
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

  describe("a short", () => {
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
    /** One specialist's BTC fill, a buy or a sell, beside the short the account holds. */
    const splitShort = (side: "buy" | "sell") => {
      const portfolio = attribute({
        observedAt: new Date(),
        holdings: [btcShort],
        fills: [{ ...fill("btc", "hyperliquid", "BTC"), side }],
        specialists: [{ id: "btc", purpose: "Bitcoin", status: "active" }],
        onItsWay: [],
        unavailable: [],
        looking: [],
        unread: () => false,
      });
      return { specialist: portfolio.specialists[0]?.usdValue, other: portfolio.other.usdValue };
    };

    it("is held by the specialist whose sell opened it", () => {
      expect(splitShort("sell")).toEqual({ specialist: "7.23", other: "0.00" });
    });

    it("is not held by a specialist that bought the coin", () => {
      expect(splitShort("buy")).toEqual({ specialist: "0.00", other: "7.23" });
    });
  });
});

describe("holdingGaps", () => {
  const perp = (coin: string, quantity: string, short = false): Holding => ({
    venue: "hyperliquid",
    chain: "hyperliquid",
    instrument: coin,
    symbol: coin,
    quantity,
    decimals: 18,
    usdValue: "1.00",
    cash: false,
    priceId: null,
    ...(short ? { short: true } : {}),
  });
  const fill = (
    specialistId: string | null,
    instrument: string,
    side: "buy" | "sell",
    quantity: string,
    chain = "hyperliquid",
  ) => ({ specialistId, chain, instrument, side, quantity });
  const read = () => false;

  it("reports a position the records still hold that is gone, as Starknet's STRK was", () => {
    // Hyperliquid liquidated 193.1 STRK on Oct 14; nothing recorded it.
    const gaps = holdingGaps({
      holdings: [],
      fills: [fill("starknet", "STRK", "buy", "193.1")],
      unread: read,
    });
    expect(gaps).toEqual([
      { key: "hyperliquid:strk", held: 0n, recorded: 193_100_000_000_000_000_000n },
    ]);
  });

  // Only a leveraged position can be recorded short of something not held at all.
  it("reports a short the records still hold that is gone, and no token recorded sold past zero", () => {
    const gaps = holdingGaps({
      holdings: [],
      fills: [fill("a", "ETH", "sell", "2"), fill("a", "0xabc", "sell", "1", "base")],
      unread: read,
    });
    expect(gaps).toEqual([{ key: "hyperliquid:eth", held: 0n, recorded: -(2n * 10n ** 18n) }]);
  });

  it("reports specialists recorded holding more than is held, the same way, short or long", () => {
    const gaps = holdingGaps({
      holdings: [perp("ETH", "1", true), perp("BTC", "1")],
      fills: [
        fill("a", "ETH", "sell", "1"),
        fill("b", "ETH", "sell", "0.5"),
        // More held than recorded is Other's, no gap.
        fill("a", "BTC", "buy", "0.5"),
      ],
      unread: read,
    });
    expect(gaps).toEqual([
      { key: "hyperliquid:eth", held: -(10n ** 18n), recorded: -(15n * 10n ** 17n) },
    ]);
  });

  it("leaves out chains that weren't read, and a token recorded sold past what was held", () => {
    const gaps = holdingGaps({
      holdings: [],
      fills: [fill("a", "STRK", "buy", "1"), fill("a", "0xabc", "sell", "1", "base")],
      unread: (chain) => chain === "hyperliquid",
    });
    expect(gaps).toEqual([]);
  });
});

describe("ownedMoveFills", () => {
  const savings = (side: "buy" | "sell", amount: string) =>
    fill(side, amount, amount, savingsTokens("monad")[0]!.token, "monad");

  it("keeps savings taken out to pay for picks outside a specialist that held none", () => {
    // A recorded case: $11.03 out of the owner's savings to buy
    // picks read as the specialist selling, and its return as +54.5%.
    const [withdrawn] = ownedMoveFills([savings("sell", "11.02628")], "specialist", []);
    expect(withdrawn?.specialistId).toBeNull();
  });

  it("gives a specialist the savings it put in, and the owner the rest", () => {
    const [owned, rest] = ownedMoveFills([savings("sell", "30")], "specialist", [
      savings("buy", "20"),
    ]);
    expect(owned).toMatchObject({ quantity: "20", usdValue: "20.00", specialistId: "specialist" });
    expect(rest).toMatchObject({ quantity: "10", usdValue: "10.00", specialistId: null });
    expect(ownedMoveFills([savings("sell", "5")], "specialist", [savings("buy", "20")])).toEqual([
      { ...savings("sell", "5"), specialistId: "specialist" },
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
  // The wallet held 11 NVIDIA: 10 of them "AI"'s and 1 loose.
  const held = { specialists: [["ai", units("10")] as const], other: units("1") };
  const sale = (quantity: string) => fill("sell", quantity, "40");

  it("writes a chat's sale to Other while Other held enough, as before", () => {
    expect(ownedSaleFills(sale("1"), null, held)).toEqual([{ ...sale("1"), specialistId: null }]);
  });

  it("writes a chat's sale past Other's share to the specialist whose holding it sold", () => {
    const pieces = ownedSaleFills(sale("4"), null, held);
    expect(pieces).toMatchObject([
      { specialistId: null, quantity: "1", usdValue: "10.00" },
      { specialistId: "ai", quantity: "3", usdValue: "30.00" },
    ]);
  });

  it("takes from the specialist that sold first, then Other, then the others", () => {
    const three = {
      specialists: [["ai", units("2")] as const, ["chips", units("5")] as const],
      other: units("1"),
    };
    expect(ownedSaleFills(sale("2"), "ai", three)).toEqual([{ ...sale("2"), specialistId: "ai" }]);
    expect(
      ownedSaleFills(sale("4"), "ai", three).map(({ specialistId, quantity }) => [
        specialistId,
        quantity,
      ]),
    ).toEqual([
      ["ai", "2"],
      [null, "1"],
      ["chips", "1"],
    ]);
  });

  it("leaves what it sold past everything with the place that sold, as an oversold sale was", () => {
    const pieces = ownedSaleFills(sale("13"), "ai", held);
    expect(pieces.map(({ specialistId, quantity }) => [specialistId, quantity])).toEqual([
      ["ai", "12"],
      [null, "1"],
    ]);
  });

  it("sells a specialist's own books first, even where the wallet falls short of everyone's", () => {
    // The wallet holds 6, but the books say 10: "chips" (first in order) 6, "ai" 4.
    const books = new Map([
      ["chips", new Map([["solana:nvda", units("6")]])],
      ["ai", new Map([["solana:nvda", units("4")]])],
    ]);
    expect(holdersOf(units("6"), books, "solana:nvda").specialists).toEqual([
      ["chips", units("6")],
    ]);
    // Sold from "ai", it's ai's 4 that went, not the 6 chips holds.
    const held = holdersOf(units("6"), books, "solana:nvda", "ai");
    expect(saleOwners(units("4"), "ai", held)).toEqual([["ai", units("4")]]);
  });

  it("shares what a swap brought in by the same weights, so a swapped holding stays its owner's", () => {
    const owners = saleOwners(units("4"), null, held);
    const bought = fill("buy", "8", "40", "tsla");
    expect(
      sharedFill(bought, owners).map(({ specialistId, quantity }) => [specialistId, quantity]),
    ).toEqual([
      [null, "2"],
      ["ai", "6"],
    ]);
  });

  it("shares its dollars so the pieces add up to the whole exactly", () => {
    const odd = fill("sell", "3", "10");
    const thirds = { specialists: [["ai", units("1")] as const], other: units("1") };
    const pieces = ownedSaleFills(odd, "chips", {
      ...thirds,
      specialists: [...thirds.specialists, ["chips", units("1")] as const],
    });
    const sum = pieces.reduce((total, piece) => total + parseUnits(piece.usdValue, 2), 0n);
    expect(sum).toBe(1000n);
  });
});
