import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { APPROVED_PRICE_AT_MOST, PriceMoved } from "../../money/approved.ts";
import type { Market } from "./markets.ts";
import { hyperliquidOrder } from "./order.ts";

const market: Market = {
  name: "SOL",
  dex: "",
  assetId: 5,
  szDecimals: 2,
  maxLeverage: 20,
  markPx: 100,
  dayVolumeUsd: 1_000_000,
  fundingRate: 0,
  collateralToken: 0,
};
let markPx = 100;

vi.mock("./markets.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./markets.ts")>()),
  findMarket: vi.fn(async () => ({ ...market, markPx })),
}));

const order = z
  .object(hyperliquidOrder.input)
  .parse({ market: "SOL", side: "long", sizeUsd: 50, leverage: 2, slippagePercent: 1.5 });
// Approved at a mark of 100 with 1.5% slippage: a long pays at most 101.5.
const card = { details: { market: "SOL", [APPROVED_PRICE_AT_MOST]: "101.5" } };

describe("a market order priced again against the card it was approved at", () => {
  beforeEach(() => {
    markPx = 100;
  });

  it("is held to the card once the mark is back inside it, as execute holds it", async () => {
    markPx = 101;
    const unheld = await hyperliquidOrder.describe(order, {});
    const held = await hyperliquidOrder.describe(order, { heldTo: card });
    // Unheld, the slippage on today's mark reaches past the card...
    expect(Number(unheld.details?.[APPROVED_PRICE_AT_MOST])).toBeGreaterThan(101.5);
    // ...but execute would cap the order at the card's price, so the quote does too.
    expect(held.details?.[APPROVED_PRICE_AT_MOST]).toBe("101.5");
  });

  it("is refused as execute would refuse it once the mark is past the card", async () => {
    markPx = 102;
    await expect(hyperliquidOrder.describe(order, { heldTo: card })).rejects.toBeInstanceOf(
      PriceMoved,
    );
  });
});

// Execute refuses each of these with nothing sent, so describe refuses it first and no card
// is ever offered for one.
describe("an order its market can't take", () => {
  beforeEach(() => {
    markPx = 100;
  });

  it("is offered no card", async () => {
    const describing = (change: object) => hyperliquidOrder.describe({ ...order, ...change }, {});
    await expect(describing({ leverage: 21 })).rejects.toThrow("SOL allows at most 20x leverage.");
    await expect(describing({ orderType: "limit" })).rejects.toThrow(
      "A limit order needs limitPrice.",
    );
    // Under Hyperliquid's $10 minimum, at the market or resting at a limit.
    const small = "Hyperliquid takes no order worth less than $10, so $8 of SOL is too small.";
    await expect(describing({ sizeUsd: 8 })).rejects.toThrow(small);
    await expect(describing({ sizeUsd: 8, orderType: "limit", limitPrice: 90 })).rejects.toThrow(
      small,
    );
    // A long's stop-loss above the price would fire at once, as would a take-profit below it.
    await expect(describing({ stopLoss: 101 })).rejects.toThrow("would trigger immediately");
    await expect(describing({ takeProfit: 99 })).rejects.toThrow("would trigger immediately");
    // A limit order's stops are held to its limit price, where it opens.
    const resting = { orderType: "limit", limitPrice: 90 };
    await expect(describing({ ...resting, stopLoss: 95 })).rejects.toThrow("below 90");
    await expect(describing({ ...resting, stopLoss: 85 })).resolves.toMatchObject({
      card: { working: "Placing your order" },
    });
  });
});
