import { describe, expect, it, vi } from "vitest";

import { approval, effectLines } from "../../money/effect.ts";
import { readPosition } from "./account.ts";
import { findMarket, type Market } from "./markets.ts";
import { hyperliquidOrder } from "./order.ts";
import { hyperliquidSetStops } from "./position.ts";
import { hyperliquidDeposit } from "./transfers.ts";

const BTC: Market = {
  name: "BTC",
  dex: "",
  assetId: 0,
  szDecimals: 5,
  maxLeverage: 40,
  markPx: 100_000,
  dayVolumeUsd: 0,
  fundingRate: 0,
  collateralToken: 0,
} as Market;

vi.mock("./markets.ts", async (original) => ({ ...(await original()), findMarket: vi.fn() }));
vi.mock("../../money/wallets.ts", async (original) => ({
  ...(await original()),
  evmAddress: async () => "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
}));
vi.mock("./account.ts", async (original) => ({ ...(await original()), readPosition: vi.fn() }));
vi.mocked(findMarket).mockResolvedValue(BTC);
const LONG = {
  size: 0.001,
  szi: "0.001",
  valueUsd: 20,
  leverage: 5,
  pnlUsd: 0,
  entryPx: 95_000,
  liquidationPx: 81_000,
};

const context = {};

// Every signature here is the owner's own over fields Auni's code builds; their cards say so.
describe("Hyperliquid's effects", () => {
  it("says a market order's margin and position, and lets nothing lasting", async () => {
    const order = { market: "BTC", side: "long", sizeUsd: 100, leverage: 5 } as const;
    const { effect } = await hyperliquidOrder.describe(
      { ...order, orderType: "market", slippagePercent: 1 },
      context,
    );
    expect(effectLines(effect)).toEqual([
      { label: "You give", value: "$20 of your Hyperliquid cash as margin" },
      { label: "You get", value: "a $100 BTC long at 5x (about 0.001 BTC) on Hyperliquid" },
    ]);
    expect(approval(effect, [])).toEqual({ kind: "tap" });
  });

  it("names each resting order as what it lets Hyperliquid do later", async () => {
    const { effect } = await hyperliquidOrder.describe(
      {
        market: "BTC",
        side: "long",
        sizeUsd: 100,
        leverage: 5,
        orderType: "limit",
        limitPrice: 95_000,
        slippagePercent: 1,
        stopLoss: 90_000,
      },
      context,
    );
    expect(effect.grants.map(({ lets }) => lets)).toEqual([
      "Hyperliquid fill it at $95,000 or better until you cancel",
      "Hyperliquid close the whole position at market if BTC reaches $90,000",
    ]);
    expect(effect.gets[0]?.lands).toBe("on Hyperliquid once it fills");
    vi.mocked(readPosition).mockResolvedValue(LONG);
    const stops = await hyperliquidSetStops.describe(
      { market: "btc", takeProfit: 120_000 },
      context,
    );
    expect(effectLines(stops.effect)).toEqual([
      { label: "Lets", value: "Hyperliquid take profit on it at market at $120,000" },
    ]);
    // Its card names the position it read, by the market as it resolved.
    expect(stops.summary).toBe("Update the stops on your BTC position");
    expect(stops.card?.title).toBe("Set a take-profit on your BTC long");
  });

  // Execute refuses each of these with nothing sent, so no card is made for one.
  it("offers no card for a change of stops it would refuse", async () => {
    vi.mocked(readPosition).mockResolvedValue(LONG);
    await expect(hyperliquidSetStops.describe({ market: "BTC" }, context)).rejects.toThrow(
      "Name a stopLoss or takeProfit",
    );
    await expect(
      hyperliquidSetStops.describe({ market: "BTC", stopLoss: 101_000 }, context),
    ).rejects.toThrow("would trigger immediately");
    vi.mocked(readPosition).mockResolvedValue(null);
    await expect(
      hyperliquidSetStops.describe({ market: "BTC", takeProfit: 120_000 }, context),
    ).rejects.toThrow("There is no open BTC position to protect.");
  });

  it("gets what a deposit sends where Auni reads it back, on Hyperliquid, less Circle's fee", async () => {
    // Circle's fee API, quoting its flat $0.20 for a fast burn.
    const forwardFee = { low: 200_000, med: 200_000, high: 200_000 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ finalityThreshold: 1000, minimumFee: 0, forwardFee }])),
    );
    const { effect } = await hyperliquidDeposit.describe({ amountUsd: 50 }, context);
    vi.unstubAllGlobals();
    expect(effectLines(effect)).toEqual([
      { label: "You give", value: "$50 of USDC on Arbitrum" },
      { label: "You get", value: "$49.80 on Hyperliquid in ~1 min" },
      { label: "Costs", value: "$0.20 Circle's fee" },
    ]);
  });
});
