import { describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { pickDetail } from "../../money/pick-detail.ts";

const DAY_MS = 86_400_000;

// Hyperliquid answers with three daily closes and a live mark 10% over a day ago.
vi.mock(import("./api.ts"), async (original) => ({
  ...(await original()),
  info: vi.fn(
    async () =>
      [700, 710, 720].map((close, index) => ({
        T: Date.now() - (3 - index) * DAY_MS,
        c: String(close),
      })) as never,
  ),
}));
vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  perpMark: vi.fn(async () => ({ mark: 770, previous: 700, funding: 0.00001 })),
  findMarket: vi.fn(async () => ({ name: "xyz:META", dex: "xyz" }) as never),
}));
vi.mock(import("./account.ts"), async (original) => ({
  ...(await original()),
  readPosition: vi.fn(async () => ({ liquidationPx: 520.5 }) as never),
}));
vi.mock(import("./open-orders.ts"), async (original) => ({
  ...(await original()),
  // The person holds a META long with a stop and a take-profit in place, and an order waiting
  // to add to it, whose own stop is not placed until it fills.
  standingOrders: vi.fn(async () => {
    const stop = { reduceOnly: true, waitsOn: null, isBuy: false, size: "1", filled: "0" };
    return [
      { ...stop, oid: 1, market: "xyz:META", kind: "stop-loss", price: "690.0" },
      { ...stop, oid: 2, market: "xyz:META", kind: "take-profit", price: "900.0" },
      { ...stop, oid: 3, market: "xyz:TSLA", kind: "stop-loss", price: "10.0" },
      { ...stop, oid: 5, market: "xyz:META", kind: "stop-loss", price: "600.0", waitsOn: 4 },
    ] as never;
  }),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(async () => "0x01"),
}));

const open = (
  action: Pick<ActionRow, "tool" | "input" | "details" | "amountUsd"> & Partial<ActionRow>,
) => pickDetail({ status: "awaiting_permission", ...action });

describe("a perp's pick detail", () => {
  it("charts a perp a pick closes, with how it has moved", async () => {
    // As production recorded one, before closes pinned their resolved market.
    const detail = await open({
      tool: "hyperliquid_close",
      input: { market: "xyz:META", percent: 100, slippagePercent: 1 },
      details: { Size: "0.045", Market: "xyz:META" },
      amountUsd: "0.00",
    });
    expect(detail?.now).toBe(770);
    expect(detail?.points).toHaveLength(4);
    expect(detail?.facts).toEqual([
      { label: "Today", value: "+10.0%" },
      { label: "3 months", value: "+10.0%" },
    ]);
  });

  it("charts a perp a pick opens, with the position it takes", async () => {
    const detail = await open({
      tool: "hyperliquid_order",
      input: { market: "xyz:META", side: "long", sizeUsd: 33, leverage: 3 },
      details: { market: "xyz:META" },
      amountUsd: "11.00",
    });
    expect(detail?.facts).toEqual([
      { label: "Position", value: "3x long" },
      { label: "Holding cost", value: "Under a cent a day" },
    ]);
  });

  it("says which way holding money goes in its label, so the figure fits", async () => {
    const detail = await open({
      tool: "hyperliquid_order",
      input: { market: "xyz:META", side: "short", sizeUsd: 500, leverage: 5 },
      details: { market: "xyz:META" },
      amountUsd: "100.00",
    });
    expect(detail?.facts[1]).toEqual({ label: "Holding pays you", value: "$0.12 a day" });
  });

  it("draws an order's own levels before it's placed, its wipe-out from today's price", async () => {
    const order = await open({
      tool: "hyperliquid_order",
      input: {
        market: "xyz:META",
        side: "long",
        sizeUsd: 50,
        leverage: 5,
        stopLoss: 700,
        takeProfit: 900,
      },
      details: { market: "xyz:META", liquidationMove: "0.2" },
      amountUsd: "10.00",
    });
    expect(order?.levels).toEqual([
      { kind: "take_profit", price: 900 },
      { kind: "stop", price: 700 },
      { kind: "liquidation", price: 616 },
    ]);
  });

  it("draws the live position's levels once it's placed", async () => {
    const placed = await open({
      tool: "hyperliquid_order",
      input: { market: "xyz:META", side: "long", sizeUsd: 50, leverage: 5 },
      details: { market: "xyz:META" },
      amountUsd: "10.00",
      status: "done",
    });
    expect(placed?.levels).toEqual([
      { kind: "take_profit", price: 900 },
      { kind: "stop", price: 690 },
      { kind: "liquidation", price: 520.5 },
    ]);
  });

  it("draws the stops of an order still waiting, which are in place before its position is", async () => {
    const { readPosition } = await import("./account.ts");
    const { standingOrders } = await import("./open-orders.ts");
    const waiting = {
      tool: "hyperliquid_order" as const,
      input: { market: "xyz:META", side: "long", sizeUsd: 50, leverage: 5 },
      details: { market: "xyz:META" },
      amountUsd: "10.00",
      status: "done" as const,
    };
    const stop = { reduceOnly: true, waitsOn: null, market: "xyz:META", kind: "stop-loss" };
    const order = { ...stop, oid: 4, kind: "limit", reduceOnly: false, price: "650.0" };
    vi.mocked(readPosition).mockResolvedValue(null);
    vi.mocked(standingOrders).mockResolvedValueOnce([
      { ...stop, oid: 1, price: "600.0" },
      order,
    ] as never);
    expect((await open(waiting))?.levels).toEqual([{ kind: "stop", price: 600 }]);
    // With no order waiting either, the stop is left over and is nobody's level.
    vi.mocked(standingOrders).mockResolvedValueOnce([{ ...stop, oid: 1, price: "600.0" }] as never);
    expect((await open({ ...waiting, input: { ...waiting.input, sizeUsd: 51 } }))?.levels).toEqual(
      [],
    );
  });

  it("has nothing to chart for a move that only moves cash", async () => {
    const detail = await open({
      tool: "hyperliquid_deposit",
      input: { amountUsd: 20 },
      details: {},
      amountUsd: "20.00",
    });
    expect(detail).toBeNull();
  });
});
