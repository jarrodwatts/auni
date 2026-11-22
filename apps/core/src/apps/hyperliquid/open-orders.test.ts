import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hyperliquidOpenOrders, standingOrders, stopsInPlace } from "./open-orders.ts";

// What Hyperliquid answered for accounts with orders open, as it was recorded (see the fixture).
const { answer: OPEN } = JSON.parse(
  readFileSync(new URL("fixtures/orders/open.json", import.meta.url), "utf8"),
) as { readonly answer: readonly { readonly coin: string }[] };

const position = (coin: string, szi: string) => ({
  position: {
    coin,
    szi,
    entryPx: null,
    liquidationPx: null,
    unrealizedPnl: "0",
    marginUsed: "10",
    leverage: { value: 3 },
  },
});

const asked = vi.hoisted(() => ({ dexes: [] as unknown[] }));

vi.mock(import("./api.ts"), async (original) => ({
  ...(await original()),
  info: vi.fn(async (body: Record<string, unknown>) => {
    if (body.type === "frontendOpenOrders") {
      asked.dexes.push(body.dex);
      return OPEN;
    }
    if (body.type === "clearinghouseState")
      return {
        withdrawable: "0",
        marginSummary: { accountValue: "20" },
        // A short the stops are on, and a long on a market with a stop that only waits.
        assetPositions: [position("ETH", "-0.0292"), position("SOL", "0.3")],
      };
    throw new Error(`no answer for ${String(body.type)}`);
  }) as never,
}));
vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  listDexes: vi.fn(async () => [{ index: 0, name: "" }]),
  tradedMarkets: vi.fn(async () => []),
  findMarket: vi.fn(async (query: string) => ({ name: query.toUpperCase(), dex: "" }) as never),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(async () => "0x0000000000000000000000000000000000000001"),
}));

beforeEach(() => {
  asked.dexes = [];
});

describe("the orders open on Hyperliquid", () => {
  it("lists a stop attached to a resting order once, as waiting on that order", async () => {
    const orders = await standingOrders("0x01", "");
    // Hyperliquid lists each attached stop twice, under its order and on its own.
    expect(orders.filter(({ market }) => market === "SOL")).toEqual([
      expect.objectContaining({ oid: 602505323035, kind: "take-profit", waitsOn: 602505323033 }),
      expect.objectContaining({ oid: 602505323034, kind: "stop-loss", waitsOn: 602505323033 }),
      expect.objectContaining({
        oid: 602505323033,
        kind: "limit",
        isBuy: false,
        reduceOnly: false,
        size: "0.72",
        filled: "0",
        price: "82.941",
        waitsOn: null,
      }),
    ]);
  });

  it("counts as in place only the stops that wait on no order", async () => {
    const orders = await standingOrders("0x01", "");
    // The SOL stops wait on an order that hasn't filled, so SOL has none in place.
    expect(stopsInPlace(orders, "SOL")).toEqual({ stopLoss: [], takeProfit: [] });
    expect(stopsInPlace(orders, "ETH")).toEqual({
      stopLoss: [expect.objectContaining({ price: "2051.4", size: "0.0292", waitsOn: null })],
      takeProfit: [expect.objectContaining({ price: "2023.7", size: "0.0292", waitsOn: null })],
    });
    // A stop on a whole position has no size of its own.
    expect(stopsInPlace(orders, "PENDLE").takeProfit).toEqual([
      expect.objectContaining({ price: "5.18", size: null }),
    ]);
  });

  it("says how much of an order has filled", async () => {
    const { info } = await import("./api.ts");
    vi.mocked(info).mockResolvedValueOnce([
      { ...OPEN.find(({ coin }) => coin === "SOL" && true), sz: "0.5", origSz: "0.72" },
    ] as never);
    const [order] = await standingOrders("0x01", "");
    expect(order).toMatchObject({ size: "0.5", filled: "0.22" });
  });
});

describe("hyperliquid_open_orders", () => {
  const read = async (input: { market?: string } = {}) => {
    const answer = await hyperliquidOpenOrders.handler(input);
    const [said] = answer.content as { text: string }[];
    return {
      ...answer,
      ...(JSON.parse(said!.text) as {
        orders: unknown[];
        positions: unknown[];
        stopsWithNoPosition: unknown[];
      }),
    };
  };

  it("tells the agent each order waiting, with the stops that wait on it", async () => {
    const { orders, structuredContent } = await read();
    expect(orders).toEqual([
      {
        order: "602505323033",
        market: "SOL",
        does: "sells",
        limitPrice: "82.941",
        stillToFill: "0.72",
        filledSoFar: "0",
        placedAt: "2026-11-12T07:12:45.753Z",
        stopsWaitingOnIt: [
          { order: "602505323035", triggerPrice: "81.959", closesA: "short", closes: "0.72" },
          { order: "602505323034", triggerPrice: "83.079", closesA: "short", closes: "0.72" },
        ],
      },
    ]);
    expect(structuredContent).toEqual({ found: "1 order waiting" });
  });

  it("tells the agent which stops are in place on each position, so a bare one shows", async () => {
    const { positions } = await read();
    expect(positions).toEqual([
      {
        market: "ETH",
        side: "short",
        size: "0.0292",
        leverage: 3,
        stopLossInPlace: [
          { order: "602503113244", triggerPrice: "2051.4", closesA: "short", closes: "0.0292" },
        ],
        takeProfitInPlace: [
          { order: "602503113245", triggerPrice: "2023.7", closesA: "short", closes: "0.0292" },
        ],
      },
      // Its only stops wait on the order above, so the position itself has none.
      {
        market: "SOL",
        side: "long",
        size: "0.3",
        leverage: 3,
        stopLossInPlace: [],
        takeProfitInPlace: [],
      },
    ]);
  });

  // A position's stops rest on Hyperliquid before the position does, beside the order that
  // will open it. With no order either, nothing is left for them to protect.
  it("tells the agent of stops with no position: what they are there for, or that they are left over", async () => {
    const { stopsWithNoPosition } = await read();
    expect(stopsWithNoPosition).toEqual([
      {
        market: "PENDLE",
        stopLoss: [],
        takeProfit: [
          {
            order: "591167727814",
            triggerPrice: "5.18",
            closesA: "long",
            closes: "the whole position, whatever its size when it fires",
          },
        ],
        protects:
          "nothing: left over from an order that ended. It would act on the next position opened here, so offer to remove it with hyperliquid_cancel_order.",
      },
    ]);
    const { info } = await import("./api.ts");
    const pendle = OPEN.find(({ coin }) => coin === "PENDLE")!;
    const waiting = {
      ...pendle,
      oid: 7,
      side: "B",
      isTrigger: false,
      reduceOnly: false,
      orderType: "Limit",
      sz: "10.0",
      origSz: "10.0",
    };
    vi.mocked(info).mockImplementationOnce(async () => [pendle, waiting] as never);
    expect((await read({ market: "pendle" })).stopsWithNoPosition).toEqual([
      expect.objectContaining({
        market: "PENDLE",
        protects: "whatever fills of the orders waiting on this market, from the first coin",
      }),
    ]);
  });

  it("reads one market alone when asked", async () => {
    const { orders, positions } = await read({ market: "eth" });
    expect(orders).toEqual([]);
    expect(positions).toEqual([expect.objectContaining({ market: "ETH" })]);
    expect(asked.dexes).toEqual([undefined]);
  });
});
