import { describe, expect, it } from "vitest";

import { savingsTokens } from "../apps/registry.ts";
import {
  buildPortfolio,
  buyersOf,
  gainOf,
  holdersOf,
  holdingsByThread,
  ownedMoveFills,
  saleOwners,
  sharedFill,
  type PotFill,
  worthUsd,
} from "./books.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import { madeUsd } from "./made.ts";
import type { Holding } from "./portfolio.ts";
import { plainCashUsd } from "./readings.ts";
import { centsToUsd, parseUnits, signedUsdToCents, usdToCents } from "./usd.ts";

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

describe("holdingsByThread", () => {
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
  const ofThread = (
    threadId: string,
    holdings: Holding[],
    fills: Parameters<typeof holdingsByThread>[1],
  ) => holdingsByThread(holdings, fills).threads.get(threadId) ?? [];

  it("attributes a short to the thread whose sell opened it, never to a buyer", () => {
    const sellFill = {
      threadId: "btc",
      chain: "hyperliquid",
      instrument: "BTC",
      side: "sell" as const,
      quantity: "0.00023",
      usdValue: "20.00",
    };
    const buyFill = { ...sellFill, side: "buy" as const };
    expect(ofThread("btc", [btcShort], [sellFill])).toEqual([btcShort]);
    expect(ofThread("btc", [btcShort], [buyFill])).toEqual([]);
  });

  /** Nvidia shares in the wallet, worth $150 each, and the wallet's own average from every fill. */
  const nvidia = (quantity: string, averageCostUsd?: string): Holding => ({
    venue: "wallet",
    chain: "monad",
    instrument: "0xnvda",
    symbol: "NVDAx",
    quantity,
    decimals: 18,
    usdValue: (Number(quantity) * 150).toFixed(2),
    cash: false,
    priceId: null,
    ...(averageCostUsd ? { averageCostUsd } : {}),
  });
  const bought = (
    threadId: string | null,
    side: "buy" | "sell",
    quantity: string,
    usd: string,
  ) => ({
    threadId,
    ...fill(side, quantity, usd, "0xnvda", "monad"),
  });
  const gains = (split: ReturnType<typeof holdingsByThread>) =>
    Object.fromEntries(
      [...split.threads].map(([id, held]) => [
        id,
        held.map((holding) => {
          const gain = gainOf(holding)!;
          return { cost: gain.costCents, change: gain.changeCents };
        }),
      ]),
    );

  it("costs each take what its own fills paid, never the wallet's average", () => {
    // A bought one at $100 and B one at $200: the wallet's average is $150, and they're worth $150.
    const split = holdingsByThread(
      [nvidia("2", "150")],
      [bought("A", "buy", "1", "100.00"), bought("B", "buy", "1", "200.00")],
    );
    expect(gains(split)).toEqual({
      A: [{ cost: 10_000n, change: 5_000n }],
      B: [{ cost: 20_000n, change: -5_000n }],
    });
  });

  it("keeps a take's cost when the owner buys more of it outside any take", () => {
    // A bought 2 for $200 and sold 1; then 1 was bought loose for $120.
    const split = holdingsByThread(
      [nvidia("2")],
      [
        bought("A", "buy", "2", "200.00"),
        bought("A", "sell", "1", "150.00"),
        bought(null, "buy", "1", "120.00"),
      ],
    );
    expect(gains(split)).toEqual({ A: [{ cost: 10_000n, change: 5_000n }] });
    expect(split.loose.map(({ quantity }) => quantity)).toEqual(["1"]);
  });

  it("knows a take's cost though some of the holding came from elsewhere", () => {
    // 5 sent in from an exchange, and 10 a take bought at $100: the wallet's own cost is unknown.
    const split = holdingsByThread([nvidia("15")], [bought("A", "buy", "10", "1000.00")]);
    expect(gains(split)).toEqual({ A: [{ cost: 100_000n, change: 50_000n }] });
    expect(split.loose.map((holding) => [holding.quantity, gainOf(holding)])).toEqual([
      ["5", null],
    ]);
  });

  it("adds the shares up to the wallet, to the cent", () => {
    const split = holdingsByThread(
      [{ ...nvidia("3"), usdValue: "100.00" }],
      ["A", "B", "C"].map((id) => bought(id, "buy", "1", "10.00")),
    );
    const cents = [...split.threads.values(), split.loose]
      .flat()
      .reduce((sum, holding) => sum + BigInt(Math.round(Number(holding.usdValue) * 100)), 0n);
    expect(cents).toBe(10_000n);
  });

  it("gives a take its share of what the venue says a perp made", () => {
    // 0.02 BTC long at 3x from $60,000: $400 of margin, now worth $450, $50 made by the venue.
    const long: Holding = {
      venue: "hyperliquid",
      chain: "hyperliquid",
      instrument: "BTC",
      symbol: "BTC",
      quantity: "0.02",
      decimals: 18,
      usdValue: "450.00",
      cash: false,
      priceId: null,
      leverage: 3,
      averageCostUsd: "60000",
      unrealizedPnlUsd: "50.01",
    };
    const perp = (threadId: string) => ({
      threadId,
      ...fill("buy", "0.01", "600.00", "BTC", "hyperliquid"),
    });
    const split = holdingsByThread([long], [perp("A"), perp("B")]);
    // Each holds half: $200 of margin, and half the venue's $50.01, the last share the odd cent.
    expect(gains(split)).toEqual({
      A: [{ cost: 20_000n, change: 2_500n }],
      B: [{ cost: 20_000n, change: 2_501n }],
    });
  });
});

describe("buyersOf", () => {
  it("gives what a sale of the owner's loose holding bought to the thread that made it", () => {
    expect(buyersOf([[null, 40n]], "kintsu")).toEqual([["kintsu", 40n]]);
    expect(
      buyersOf(
        [
          ["kintsu", 10n],
          [null, 30n],
          ["ai", 5n],
        ],
        "kintsu",
      ),
    ).toEqual([
      ["kintsu", 40n],
      ["ai", 5n],
    ]);
    // Converting to cash belongs to no thread, and neither does what it brings in.
    expect(buyersOf([[null, 40n]], null)).toEqual([[null, 40n]]);
  });
});

describe("gainOf", () => {
  const held = (fields: Partial<Holding>): Holding => ({
    venue: "wallet",
    chain: "monad",
    instrument: "0xaa",
    symbol: "NVDAx",
    quantity: "2",
    decimals: 18,
    usdValue: "250.00",
    cash: false,
    priceId: null,
    ...fields,
  });

  it("is what the units cost at their average, against their value now", () => {
    expect(gainOf(held({ averageCostUsd: "100.505" }))).toEqual({
      costCents: 20_101n,
      changeCents: 4_899n,
    });
  });

  it("is what the venue says a perp made, over the margin its entry put up", () => {
    const long = { venue: "hyperliquid", chain: "hyperliquid", instrument: "BTC", leverage: 3 };
    // Worth $190 with extra margin added, yet $12.50 down by the venue: never value less margin.
    expect(
      gainOf(
        held({
          ...long,
          quantity: "0.01",
          averageCostUsd: "60000",
          usdValue: "190.00",
          unrealizedPnlUsd: "-12.50",
        }),
      ),
    ).toEqual({ costCents: 20_000n, changeCents: -1_250n });
    // What the venue doesn't say, Auni doesn't work out.
    expect(gainOf(held({ ...long, quantity: "0.01", averageCostUsd: "60000" }))).toBeNull();
  });

  it("is unknown without an average cost or a price now", () => {
    expect(gainOf(held({}))).toBeNull();
    expect(gainOf(held({ averageCostUsd: "100", usdValue: null }))).toBeNull();
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

describe("holdingsByThread, shared perps and growing savings", () => {
  const perpFill = (threadId: string, side: "buy" | "sell", size: string, usd: string) => ({
    threadId,
    ...fill(side, size, usd, "ETH", "hyperliquid"),
  });
  const gainsOf = (split: ReturnType<typeof holdingsByThread>) =>
    Object.fromEntries(
      [...split.threads].map(([id, held]) => [id, held.map((holding) => gainOf(holding))]),
    );
  // A shorted 1 ETH at $3,000 and B 1 at $2,000: the venue's entry is $2,500.
  const twoShorts = [perpFill("A", "sell", "1", "3000.00"), perpFill("B", "sell", "1", "2000.00")];
  const ethShort = (over: Partial<Holding>): Holding => ({
    venue: "hyperliquid",
    chain: "hyperliquid",
    instrument: "ETH",
    symbol: "ETH",
    quantity: "2",
    decimals: 18,
    usdValue: "5200.00",
    cash: false,
    priceId: null,
    short: true,
    leverage: 1,
    averageCostUsd: "2500",
    unrealizedPnlUsd: "200.00",
    ...over,
  });

  it("gains each take on a shared perp from its own entry, not a split of the venue's", () => {
    // The mark is $2,400.
    const split = holdingsByThread([ethShort({})], twoShorts);
    expect(gainsOf(split)).toEqual({
      A: [{ costCents: 300_000n, changeCents: 60_000n }],
      B: [{ costCents: 200_000n, changeCents: -40_000n }],
    });
    // Each keeps its part of what the venue holds, which closing it frees.
    const values = [...split.threads.values()].flat().map(({ usdValue }) => usdValue);
    expect(values).toEqual(["2600.00", "2600.00"]);
  });

  it.each([
    // At 10x the margin is $500, and the venue's value $500 + $200 made.
    { leverage: 10, usdValue: "700.00", unrealizedPnlUsd: "200.00" },
    // At 5x with the mark at $2,600, $1,000 of margin less $200 lost.
    { leverage: 5, usdValue: "800.00", unrealizedPnlUsd: "-200.00" },
  ])("never values a share of a shared perp at $leverage times leverage below nothing", (over) => {
    const split = holdingsByThread([ethShort(over)], twoShorts);
    const shares = [...split.threads.values()].flat();
    expect(shares.map(({ usdValue }) => usdValue)).toEqual([
      centsToUsd(usdToCents(over.usdValue) / 2n),
      centsToUsd(usdToCents(over.usdValue) / 2n),
    ]);
    // What GET /takes adds up for each take.
    for (const held of split.threads.values()) expect(() => worthUsd(held)).not.toThrow();
    // Their own entries still part what the venue made: A's $3,000 short is $1,000 better off.
    const made = shares.map(({ unrealizedPnlUsd }) => signedUsdToCents(unrealizedPnlUsd!));
    expect(made[0]! - made[1]!).toBe(100_000n);
    expect(made[0]! + made[1]!).toBe(signedUsdToCents(over.unrealizedPnlUsd));
  });

  it("gives what no take holds beside a take's own the rest of the venue's gain", () => {
    // A went long 1 BTC at $55,000; 1 more came from outside Auni. Venue entry $60,000, mark $60,000.
    const long: Holding = {
      venue: "hyperliquid",
      chain: "hyperliquid",
      instrument: "BTC",
      symbol: "BTC",
      quantity: "2",
      decimals: 18,
      usdValue: "120000.00",
      cash: false,
      priceId: null,
      leverage: 1,
      averageCostUsd: "60000",
      unrealizedPnlUsd: "0.00",
    };
    const split = holdingsByThread(
      [long],
      [{ threadId: "A", ...fill("buy", "1", "55000.00", "BTC", "hyperliquid") }],
    );
    // A made $5,000; the other BTC, which must have got in at $65,000, lost it.
    expect(gainsOf(split).A).toEqual([{ costCents: 5_500_000n, changeCents: 500_000n }]);
    expect(
      split.loose.map((holding) => [holding.averageCostUsd, holding.unrealizedPnlUsd]),
    ).toEqual([["65000", "-5000.00"]]);
  });

  const aUsdc = savingsTokens("monad")[0]!.token;
  const savings = (quantity: string): Holding => ({
    venue: "aave",
    chain: "monad",
    instrument: aUsdc,
    symbol: "aUSDC",
    quantity,
    decimals: 6,
    usdValue: quantity,
    cash: true,
    priceId: null,
  });
  const saved = (threadId: string | null, quantity: string, createdAt: Date) => ({
    threadId,
    createdAt,
    ...fill("buy", quantity, quantity, aUsdc, "monad"),
  });
  /** aUSDC core recorded arriving from outside Auni (see arrivalFlows). */
  const sentIn = (usd: number, at: Date) => ({
    at: at.getTime(),
    usd,
    key: fillIdentity({ chain: "monad", instrument: aUsdc }),
  });
  const now = new Date("2026-11-01T00:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const quantities = (split: ReturnType<typeof holdingsByThread>) => ({
    ...Object.fromEntries([...split.threads].map(([id, [held]]) => [id, held!.quantity])),
    loose: split.loose.map(({ quantity }) => quantity),
  });

  it("gives the interest savings earned to the takes that put them in, at what they paid", () => {
    // A saved $3,000 and B $1,000; it has grown to $4,012.50 since.
    const split = holdingsByThread(
      [savings("4012.5")],
      [saved("A", "3000", daysAgo(60)), saved("B", "1000", daysAgo(60))],
      now,
    );
    expect(gainsOf(split)).toEqual({
      A: [{ costCents: 300_000n, changeCents: 937n }],
      B: [{ costCents: 100_000n, changeCents: 313n }],
    });
    expect(split.loose).toEqual([]);
  });

  it("gives interest to the take that held the money while it earned", () => {
    // A saved $1,000 a year ago and earned $50; B saved $1,000 yesterday.
    const split = holdingsByThread(
      [savings("2050")],
      [saved("A", "1000", daysAgo(365)), saved("B", "1000", daysAgo(1))],
      now,
    );
    expect(quantities(split)).toEqual({ A: "1049.863387", B: "1000.136613", loose: [] });
  });

  it("leaves savings sent in from outside out of the takes, however long they've saved", () => {
    // A saved $100 a year ago, earning $5, and $10,000 yesterday; then $1,000 of aUSDC came in
    // from an exchange.
    const split = holdingsByThread(
      [savings("11105")],
      [saved("A", "100", daysAgo(365)), saved("A", "10000", daysAgo(1))],
      now,
      [sentIn(1000, daysAgo(0))],
    );
    expect(quantities(split)).toEqual({ A: "10105", loose: ["1000"] });
  });

  it("gives a take only the interest beside savings sent in a month after it saved", () => {
    // A saved $4,000 a month ago and earned $15; then $1,000 of aUSDC came in from an exchange.
    const split = holdingsByThread([savings("5015")], [saved("A", "4000", daysAgo(30))], now, [
      sentIn(1000, daysAgo(0)),
    ]);
    expect(quantities(split)).toEqual({ A: "4015", loose: ["1000"] });
  });

  it("shares interest with the owner's own savings, by what each put in and for how long", () => {
    // A saved $1,000 two months ago; the owner saved $1,000 themselves then too, and $1,000 was
    // there when Auni first looked. All of it earned $30.
    const split = holdingsByThread(
      [savings("3030")],
      [saved("A", "1000", daysAgo(60)), saved(null, "1000", daysAgo(60))],
      now,
      [sentIn(1000, daysAgo(60))],
    );
    expect(quantities(split)).toEqual({ A: "1010", loose: ["2020"] });
  });
});
