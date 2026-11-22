import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import type { Signer } from "../../money/recipe.ts";
import { cancelOrders, cancelTagged, readPosition } from "./account.ts";
import type { Market } from "./markets.ts";
import { standingOrders, type Standing } from "./open-orders.ts";
import { placeStops } from "./orders.ts";
import { hyperliquidClose, hyperliquidSetStops } from "./position.ts";
import { protectionOf, replacedBy } from "./stops.ts";

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
};

const stop = (oid: number, kind: Standing["kind"], waitsOn: number | null = null): Standing => ({
  oid,
  market: "BTC",
  kind,
  isBuy: false,
  reduceOnly: true,
  size: null,
  filled: "0",
  price: kind === "stop-loss" ? "90000" : "120000",
  waitsOn,
  tag: null,
  placedAt: 0,
});
const order = (oid: number): Standing => ({
  ...stop(oid, "limit"),
  isBuy: true,
  reduceOnly: false,
  size: "0.01",
  price: "95000",
});

// A BTC long with a stop-loss (1) and a take-profit (2) in place, and a limit order (3) still
// resting to add to it, placed in Hyperliquid's own app with a stop-loss (4) and a take-profit
// (5) of its own, which wait on it.
const OPEN: readonly Standing[] = [
  stop(1, "stop-loss"),
  stop(2, "take-profit"),
  order(3),
  stop(4, "stop-loss", 3),
  stop(5, "take-profit", 3),
];

vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  findMarket: vi.fn(async () => BTC),
}));
vi.mock(import("./open-orders.ts"), async (original) => ({
  ...(await original()),
  standingOrders: vi.fn(),
}));
vi.mock(import("./account.ts"), async (original) => ({
  ...(await original()),
  readPosition: vi.fn(),
  cancelOrders: vi.fn(async () => []),
  cancelTagged: vi.fn(async () => []),
}));
vi.mock(import("./orders.ts"), async (original) => ({
  ...(await original()),
  placeOrder: vi.fn(async (_wallets, action) => ({ oid: 9, filled: action.orders[0]?.s ?? "0" })),
  placeStops: vi.fn(),
}));

const long = {
  size: 0.01,
  szi: "0.01",
  valueUsd: 300,
  leverage: 3,
  pnlUsd: 0,
  entryPx: null,
  liquidationPx: null,
};
const wallets = { evmAddress: "0x01" } as Signer;
const action = { id: "5f0c2a8e-1b7d-4c3a-9e2f-0a1b2c3d4e5f", attempts: 1 } as ActionRow;
/** The ids of the orders a move cancelled. */
const cancelled = () => vi.mocked(cancelOrders).mock.calls.flatMap(([, , oids]) => oids);
/** The stops a move placed: each one's size and trigger. */
const placed = () =>
  vi.mocked(placeStops).mock.calls.flatMap(([, request]) =>
    request.orders.map((leg) => ({
      grouping: request.grouping,
      size: leg.s,
      closesOnly: leg.r,
      trigger: "trigger" in leg.t ? leg.t.trigger.triggerPx : null,
    })),
  );
const setStops = (input: { stopLoss?: number | null; takeProfit?: number | null }) =>
  hyperliquidSetStops.execute({
    action,
    input: { market: "BTC", ...input },
    wallets,
    recordSent: async () => {},
    posting: (_chain, post) => post(),
  });
const closeAll = () =>
  hyperliquidClose.execute({
    action: { ...action, details: { side: "long", closesUpTo: "0.01", priceAtLeast: "99000" } },
    input: { market: "BTC", percent: 100, slippagePercent: 1 },
    wallets,
    recordSent: async () => {},
    posting: (_chain, post) => post(),
  });

beforeEach(() => {
  vi.mocked(cancelOrders).mockReset().mockResolvedValue([]);
  vi.mocked(cancelTagged).mockReset().mockResolvedValue([]);
  vi.mocked(placeStops)
    .mockReset()
    .mockImplementation(async (_wallets, request) => request.orders.map(() => null));
  vi.mocked(readPosition).mockReset().mockResolvedValue(long);
  vi.mocked(standingOrders)
    .mockReset()
    .mockResolvedValue([...OPEN]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("what protects a position", () => {
  it("is the stops that wait on no order, whether or not it is open yet", () => {
    expect(protectionOf(OPEN, "BTC", true)).toEqual({
      stopLoss: [stop(1, "stop-loss")],
      takeProfit: [stop(2, "take-profit")],
      leftOver: false,
    });
    // With nothing held, an order waiting to open is what the stops are there for.
    expect(protectionOf(OPEN, "BTC", false).leftOver).toBe(false);
  });

  it("is left over once nothing is held and no order waits to open anything", () => {
    const stops = [stop(1, "stop-loss"), stop(2, "take-profit")];
    expect(protectionOf(stops, "BTC", false).leftOver).toBe(true);
    // An order that can only close opens nothing, and another market's order is not this one's.
    const closing = { ...order(3), reduceOnly: true };
    expect(protectionOf([...stops, closing], "BTC", false).leftOver).toBe(true);
    expect(protectionOf([...stops, { ...order(3), market: "ETH" }], "BTC", false).leftOver).toBe(
      true,
    );
  });

  it("gives way by kind to a move's own stops, and altogether when left over", () => {
    const held = protectionOf(OPEN, "BTC", true);
    expect(replacedBy(held, { stopLoss: 92_000 }).map(({ oid }) => oid)).toEqual([1]);
    expect(replacedBy(held, {})).toEqual([]);
    const leftOver = { ...held, leftOver: true };
    expect(replacedBy(leftOver, {}).map(({ oid }) => oid)).toEqual([1, 2]);
    expect(replacedBy(leftOver, { stopLoss: 92_000 }).map(({ oid }) => oid)).toEqual([1, 2]);
  });
});

describe("a change of stops", () => {
  it("puts the new one on for the whole position before the old one comes off", async () => {
    expect(await setStops({ stopLoss: 92_000 })).toEqual({ txs: [], fills: [] });
    // Size "0": Hyperliquid closes whatever the position is when it fires.
    expect(placed()).toEqual([
      { grouping: "positionTpsl", size: "0", closesOnly: true, trigger: "92000" },
    ]);
    expect(cancelled()).toEqual([1]);
    expect(vi.mocked(placeStops).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(cancelOrders).mock.invocationCallOrder[0]!,
    );
  });

  it("removes the ones it names and places none", async () => {
    await setStops({ stopLoss: null, takeProfit: null });
    expect(placeStops).not.toHaveBeenCalled();
    expect(cancelled()).toEqual([1, 2]);
  });

  // A stop attached to an order in Hyperliquid's own app is that order's until it fills.
  it("leaves alone a stop that waits on an order still resting", async () => {
    await setStops({ stopLoss: 92_000, takeProfit: 125_000 });
    expect(cancelled()).toEqual([1, 2]);
  });

  it("is all or none: one refused takes the other back, and the old stops stay", async () => {
    vi.mocked(placeStops).mockResolvedValue([null, "Invalid TP/SL price."]);
    // A price Hyperliquid refuses though Auni let it through: its mark had moved.
    await expect(setStops({ stopLoss: 92_000, takeProfit: 100_100 })).rejects.toThrow(
      "Hyperliquid refused the stop's price. A stop-loss or take-profit has to sit past the market's price now, or it would fire the moment it was set. Your stops are as they were.",
    );
    // Only the one Hyperliquid took is taken back, by the tag it was sent with.
    expect(vi.mocked(cancelTagged).mock.calls.map(([, , tags]) => tags)).toEqual([
      ["0x5f0c2a8e1b7d4c3a9e2f0a1b2c3d4e00"],
    ]);
    expect(cancelOrders).not.toHaveBeenCalled();
  });

  it("tags a second attempt's stops apart from the first's", async () => {
    await hyperliquidSetStops.execute({
      action: { ...action, attempts: 2 },
      input: { market: "BTC", stopLoss: 92_000, takeProfit: 125_000 },
      wallets,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
    const [, request] = vi.mocked(placeStops).mock.calls[0]!;
    expect(request.orders.map(({ c }) => c?.slice(-2))).toEqual(["02", "03"]);
  });

  it("fails a removal that didn't go, and notes an old stop left beside a new one", async () => {
    vi.mocked(cancelOrders).mockRejectedValue(new Error("fetch failed"));
    await expect(setStops({ stopLoss: null })).rejects.toThrow(
      "The earlier stop-loss at $90,000 could not be taken off, and may still be in place.",
    );
    expect(await setStops({ stopLoss: 92_000 })).toMatchObject({
      note: "The earlier stop-loss at $90,000 could not be taken off, and may still be in place.",
    });
  });
});

describe("what a cancel leaves standing", () => {
  const gone = "Order was never placed, already canceled, or filled.";

  it("believes a refusal that says a stop is gone once Hyperliquid no longer lists it", async () => {
    vi.mocked(cancelOrders).mockResolvedValue([gone]);
    // The old stop-loss fired a moment ago: listed when read, gone when read again.
    vi.mocked(standingOrders)
      .mockResolvedValueOnce([...OPEN])
      .mockResolvedValueOnce([...OPEN])
      .mockResolvedValue(OPEN.filter(({ oid }) => oid !== 1));
    expect(await setStops({ stopLoss: 92_000 })).not.toHaveProperty("note");
  });

  it("says a stop may still stand when Hyperliquid refuses to cancel it and still lists it", async () => {
    vi.mocked(cancelOrders).mockResolvedValue([gone]);
    expect(await setStops({ stopLoss: 92_000 })).toMatchObject({
      note: "The earlier stop-loss at $90,000 could not be taken off, and may still be in place.",
    });
  });
});

describe("a change of stops never leaves an order waiting bare", () => {
  it("refuses a stop-loss the price must pass before an order waiting to add can fill", async () => {
    // Order 3 waits to buy more at $95,000: a stop at $97,000 fires first, and is then used up.
    await expect(setStops({ stopLoss: 97_000 })).rejects.toThrow(
      "A long order still waits on BTC at $95,000, below this stop-loss at $97,000",
    );
    expect(placeStops).not.toHaveBeenCalled();
  });
});

describe("closing a whole position", () => {
  // The position is there for the close and gone once it has filled.
  const closes = () =>
    vi.mocked(readPosition).mockReset().mockResolvedValueOnce(long).mockResolvedValue(null);

  it("takes its stops off with it, since nothing is left for them to close", async () => {
    closes();
    vi.mocked(standingOrders).mockResolvedValue([stop(1, "stop-loss"), stop(2, "take-profit")]);
    expect(await closeAll()).not.toHaveProperty("note");
    expect(cancelled()).toEqual([1, 2]);
  });

  it("leaves them while an order still waits to open more of it", async () => {
    closes();
    expect(await closeAll()).not.toHaveProperty("note");
    expect(cancelOrders).not.toHaveBeenCalled();
  });

  it("says so when they could not be taken off", async () => {
    closes();
    vi.mocked(standingOrders).mockResolvedValue([stop(1, "stop-loss")]);
    vi.mocked(cancelOrders).mockRejectedValue(new Error("fetch failed"));
    expect(await closeAll()).toMatchObject({
      note: "Its stop-loss and take-profit may still be on Hyperliquid.",
    });
  });
});
