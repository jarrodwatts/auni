import { describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { moneyOf, type Signer } from "../../money/recipe.ts";
import type { Market } from "./markets.ts";
import { placeOrder } from "./orders.ts";
import { hyperliquidClose } from "./position.ts";

const META: Market = {
  name: "xyz:META",
  dex: "xyz",
  assetId: 110_010,
  szDecimals: 3,
  maxLeverage: 10,
  markPx: 700,
  dayVolumeUsd: 0,
  fundingRate: 0,
  collateralToken: 0,
};

const position = (
  coin: string,
  szi: string,
  marginUsed: string,
  unrealizedPnl = "0.0",
  type = "isolated",
) => ({
  position: {
    coin,
    szi,
    marginUsed,
    entryPx: null,
    liquidationPx: null,
    unrealizedPnl,
    leverage: { type, value: 3 },
  },
});

// The xyz dex of a standard account as Hyperliquid answers for it; each test sets it.
let dex = {
  withdrawable: "0",
  marginSummary: { accountValue: "0" },
  assetPositions: [] as ReturnType<typeof position>[],
};

vi.mock(import("./api.ts"), async (original) => ({
  ...(await original()),
  // Nothing else stands on the dex: no order waiting, and no stop; and nothing in spot.
  info: vi.fn(async ({ type }: { type: string }) => {
    if (type === "frontendOpenOrders") return [];
    if (type === "userAbstraction") return "default";
    if (type === "spotClearinghouseState") return { balances: [] };
    return dex;
  }) as never,
}));
vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  findMarket: vi.fn(async () => META),
}));
// Fills whatever it is sent in full.
vi.mock(import("./orders.ts"), async (original) => ({
  ...(await original()),
  placeOrder: vi.fn(async (_wallets, action) => ({
    oid: 1,
    filled: action.orders[0]?.s ?? "0",
  })),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(async () => "0x0000000000000000000000000000000000000001"),
}));

const close = (percent = 100) =>
  hyperliquidClose.describe({ market: "xyz:META", percent, slippagePercent: 1 }, {});

const holding = (szi: string) => {
  dex = {
    withdrawable: "0",
    marginSummary: { accountValue: "100" },
    assetPositions: [position("xyz:META", szi, "100")],
  };
};

/** Taps a close card as `describe` saved it, against the position as it is now. */
const tap = (details: Record<string, string>, percent = 100) =>
  hyperliquidClose.execute({
    action: { id: "5f0c2a8e-1b7d-4c3a-9e2f-0a1b2c3d4e5f", details } as ActionRow,
    input: { market: "xyz:META", percent, slippagePercent: 1 },
    wallets: { evmAddress: "0x01" } as Signer,
    recordSent: async () => {},
    posting: (_chain, post) => post(),
  });

/** The order a tap sent: its size, and whether it buys. */
const sent = () => {
  const [, action] = vi.mocked(placeOrder).mock.lastCall ?? [];
  return { size: action?.orders[0]?.s, isBuy: action?.orders[0]?.b };
};

describe("hyperliquidClose", () => {
  it("spends nothing and records what the position is worth as coming back", async () => {
    // An isolated position's margin carries its profit and loss: $20.60 of the $30.60 is locked in it.
    dex = {
      withdrawable: "10.00",
      marginSummary: { accountValue: "30.60" },
      assetPositions: [position("xyz:META", "0.09", "20.60", "-4.63")],
    };
    const preview = await close();
    expect(preview.amountUsd).toBe("0");
    expect(preview.details).toEqual({
      market: "xyz:META",
      returnsUsd: "20.60",
      side: "long",
      closesUpTo: "0.09",
      // A long closes by selling, at no less than the mark less its 1% slippage.
      priceAtLeast: "693",
      leverage: "3",
      sizeUsd: "63.00",
      pnlUsd: "-4.63",
    });
  });

  it("offers no part Hyperliquid would refuse as under $10, and says what it would take", async () => {
    // Live: half of a $14 ETH long, about $6.93 at its worst price, was refused once allowed.
    holding("0.02");
    await expect(close(50)).rejects.toThrow(
      "Hyperliquid takes no order worth less than $10, and 50% of your xyz:META long comes to about $6.93. Close all of it, which Hyperliquid takes at any size, close at least 75% of it, or keep it as it is.",
    );
    // 75% is 0.015, $10.40 at its worst price; the whole of it goes at any size.
    await expect(close(75)).resolves.toMatchObject({ details: { closesUpTo: "0.015" } });
    await expect(close()).resolves.toMatchObject({ details: { closesUpTo: "0.02" } });
    // A position under $10 has no part Hyperliquid takes, so only the whole of it is offered.
    holding("-0.01");
    await expect(close(99)).rejects.toThrow(
      "Hyperliquid takes no order worth less than $10, and 99% of your xyz:META short comes to about $6.30. Close all of it, which Hyperliquid takes at any size, or keep it as it is.",
    );
    await expect(close()).resolves.toMatchObject({
      details: { side: "short", closesUpTo: "0.01" },
    });
  });

  it("says what it closes and what that locks in, for its share of the position", async () => {
    dex = {
      withdrawable: "10.00",
      marginSummary: { accountValue: "30.60" },
      assetPositions: [position("xyz:META", "0.09", "20.60", "-4.62")],
    };
    const { details = {} } = await close(50);
    const input = { market: "xyz:META", percent: 50, slippagePercent: 1 };
    expect(hyperliquidClose.about({ input, details, amountUsd: "0" })).toEqual({
      kind: "perp",
      market: "xyz:META",
      closes: { side: "long", leverage: 3, sizeUsd: 31.5, all: false, pnlUsd: -2.31 },
    });
  });

  it("returns an isolated position's margin, never what an order beside it holds", async () => {
    // $36 is held: $20 by the position, $16 by orders waiting.
    dex = {
      withdrawable: "14.00",
      marginSummary: { accountValue: "50.00" },
      assetPositions: [position("xyz:META", "-0.09", "20")],
    };
    expect((await close()).details?.returnsUsd).toBe("20.00");
    expect((await close(50)).details?.returnsUsd).toBe("10.00");
  });

  it("returns a cross position's share of what cross positions hold, by its margin", async () => {
    dex = {
      withdrawable: "14.00",
      marginSummary: { accountValue: "50.00" },
      assetPositions: [
        position("xyz:META", "-0.09", "20", "0.0", "cross"),
        position("xyz:TSLA", "1", "10", "0.0", "cross"),
      ],
    };
    expect((await close()).details?.returnsUsd).toBe("24.00");
    expect((await close(50)).details?.returnsUsd).toBe("12.00");
  });

  it("brings its recorded money back rather than putting any in", async () => {
    dex = {
      withdrawable: "10.00",
      marginSummary: { accountValue: "30.60" },
      assetPositions: [position("xyz:META", "0.09", "20.60")],
    };
    const { amountUsd, details = {} } = await close();
    const row = { input: { market: "xyz:META" }, details, run: {}, amountUsd };
    expect(moneyOf(row)).toEqual({ flow: "back", usd: "20.60" });
  });

  it("moves no money for a close whose details don't say what it returns", () => {
    const row = {
      input: { market: "xyz:META" },
      details: { market: "xyz:META" },
      run: {},
      amountUsd: "0",
    };
    expect(moneyOf(row)).toBeNull();
  });

  it("closes only what the card showed when the position grew before the tap", async () => {
    holding("1");
    const { details = {} } = await close(50);
    holding("10");
    await tap(details, 50);
    expect(sent()).toEqual({ size: "0.5", isBuy: false });
  });

  it("closes what is left when the position shrank before the tap", async () => {
    holding("-1");
    const { details = {} } = await close();
    holding("-0.4");
    await tap(details);
    expect(sent()).toEqual({ size: "0.4", isBuy: true });
  });

  it("refuses a tap once the position has changed sides", async () => {
    holding("1");
    const { details = {} } = await close();
    holding("-1");
    vi.mocked(placeOrder).mockClear();
    await expect(tap(details)).rejects.toThrow("no longer matches");
    expect(placeOrder).not.toHaveBeenCalled();
  });
});
