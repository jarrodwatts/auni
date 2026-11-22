import { expect, vi } from "vitest";

import { APPROVED_PRICE_AT_LEAST, APPROVED_PRICE_AT_MOST } from "../../money/approved.ts";
import type { ActionRow } from "../../db/schema.ts";
import { holdsToCard } from "../../test/held-to-card.ts";
import { OWNER, type Signed } from "../../test/wallets.ts";
import type { Market } from "./markets.ts";

// Hyperliquid as its API answers, stood in for over fetch: SOL at `markPx`, the owner's unified
// account holding `freeUsd` of free cash, a SOL position of `szi` coins and the stops `standing`
// on it, and an exchange that fills every order that crosses the mark in full, rests one that
// doesn't, and takes every stop. What reaches the exchange is what the owner's wallet signed
// for (Hyperliquid signs a hash of each action), so the drills read it from `posted`.
const SOL: Market = {
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

interface Posted {
  readonly type: string;
  readonly [field: string]: unknown;
}
interface OrderWire {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t: {
    readonly limit?: { readonly tif: string };
    readonly trigger?: {
      readonly isMarket: boolean;
      readonly triggerPx: string;
      readonly tpsl: "sl" | "tp";
    };
  };
}

const world = vi.hoisted(() => ({
  markPx: 100,
  szi: "0",
  freeUsd: "100",
  /** The stops in place on SOL, as frontendOpenOrders lists them. */
  standing: [] as { readonly oid: number; readonly orderType: string }[],
  posted: [] as Posted[],
}));

/** A stop in place on the SOL position, as Hyperliquid lists one. */
const standingStop = (oid: number, tpsl: "sl" | "tp", triggerPx: string) => ({
  coin: "SOL",
  side: "A",
  limitPx: triggerPx,
  sz: "0.0",
  origSz: "0.0",
  oid,
  timestamp: 0,
  isTrigger: true,
  triggerPx,
  reduceOnly: true,
  orderType: tpsl === "sl" ? "Stop Market" : "Take Profit Market",
  children: [],
  cloid: null,
});

vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  findMarket: vi.fn(async () => ({ ...SOL, markPx: world.markPx })),
  listDexes: vi.fn(async () => [{ index: 0, name: "" }]),
  tradedMarkets: vi.fn(async () => []),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
}));

/** What Hyperliquid's /info answers for each read the app makes. */
function infoAnswer(body: Record<string, unknown>): unknown {
  switch (body.type) {
    case "userAbstraction":
      return "unifiedAccount";
    case "spotClearinghouseState":
      return { balances: [{ coin: "USDC", total: world.freeUsd, hold: "0" }] };
    case "clearinghouseState": {
      const open = Number(world.szi) !== 0;
      return {
        withdrawable: "0",
        marginSummary: { accountValue: open ? "50" : "0" },
        assetPositions: open
          ? [
              {
                position: {
                  coin: "SOL",
                  szi: world.szi,
                  entryPx: "100",
                  liquidationPx: null,
                  unrealizedPnl: "0",
                  marginUsed: "50",
                  leverage: { value: 2 },
                },
              },
            ]
          : [],
      };
    }
    case "frontendOpenOrders":
      return world.standing;
    default:
      throw new Error(`The fake Hyperliquid has no answer for ${String(body.type)}`);
  }
}

/** What /exchange answers: a stop taken, an order filled in full or left resting, anything else taken. */
function exchangeAnswer(action: Posted): unknown {
  world.posted.push(action);
  if (action.type === "cancel") {
    const statuses = (action.cancels as unknown[]).map(() => "success");
    return { status: "ok", response: { type: "cancel", data: { statuses } } };
  }
  if (action.type !== "order") return { status: "ok", response: { type: "default" } };
  const orders = action.orders as readonly OrderWire[];
  const crosses = (order: OrderWire) =>
    order.b ? Number(order.p) >= world.markPx : Number(order.p) <= world.markPx;
  return {
    status: "ok",
    response: {
      type: "order",
      data: {
        statuses: orders.map((order, index) =>
          order.t.trigger
            ? "waitingForTrigger"
            : crosses(order)
              ? { filled: { oid: index + 1, totalSz: order.s, avgPx: String(world.markPx) } }
              : { resting: { oid: index + 1 } },
        ),
      },
    },
  };
}

function world_() {
  Object.assign(world, {
    markPx: 100,
    szi: "0",
    freeUsd: "100",
    standing: [],
    posted: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return Response.json(
        String(url).endsWith("/exchange")
          ? exchangeAnswer(body.action as Posted)
          : infoAnswer(body),
      );
    }),
  );
}

/** The orders the exchange was sent. */
const orders = () =>
  world.posted.flatMap((action) => (action.type === "order" ? (action.orders as OrderWire[]) : []));

/** A stop for the whole SOL position that can only close a long or a short, at the card's price. */
const wholePositionStop = (isLong: boolean, tpsl: "sl" | "tp", price: number) =>
  expect.objectContaining({
    a: SOL.assetId,
    b: !isLong,
    r: true,
    // "0" is the whole position, whatever it is when the stop fires: no size of its own.
    s: "0",
    t: { trigger: { isMarket: true, triggerPx: String(price), tpsl } },
  });

/**
 * Reads everything an order's run sent the exchange against its card, in the order it was
 * sent: the card's leverage, the card's stops for the whole position, the entry, and the
 * cancel of the stops the position had of each kind the card sets. Nothing else is signed.
 */
function orderPaysAsShown(signed: Signed, card: ActionRow) {
  expect(signed.evm).toEqual([]);
  const input = card.input as {
    side: string;
    sizeUsd: number;
    leverage: number;
    limitPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
  };
  const isLong = input.side === "long";
  const shown = (
    [
      ["sl", input.stopLoss],
      ["tp", input.takeProfit],
    ] as const
  ).flatMap(([tpsl, price]) => (price === undefined ? [] : [{ tpsl, price }]));
  const replaced = world.standing.filter(({ orderType }) =>
    shown.some(({ tpsl }) => (tpsl === "sl") === orderType.startsWith("Stop")),
  );
  expect(world.posted.map(({ type, grouping }) => grouping ?? type)).toEqual([
    "updateLeverage",
    ...(shown.length > 0 ? ["positionTpsl"] : []),
    "na",
    ...(replaced.length > 0 ? ["cancel"] : []),
  ]);
  // Isolated, at the card's leverage, so it risks only the card's margin.
  expect(world.posted[0]).toEqual({
    type: "updateLeverage",
    asset: SOL.assetId,
    isCross: false,
    leverage: input.leverage,
  });
  const requests = world.posted.filter(({ type }) => type === "order");
  const stops = shown.length > 0 ? (requests[0]!.orders as OrderWire[]) : [];
  const [entry, ...others] = requests.at(-1)!.orders as OrderWire[];
  // The stops are the card's, sent ahead of the entry, and each can only close this market's
  // position.
  expect(stops).toEqual(shown.map(({ tpsl, price }) => wholePositionStop(isLong, tpsl, price)));
  expect(others).toEqual([]);
  if (input.limitPrice === undefined) {
    // Filled now or cancelled ("Ioc"), at no worse a price than the card's.
    expect(entry).toMatchObject({
      a: SOL.assetId,
      b: isLong,
      r: false,
      t: { limit: { tif: "Ioc" } },
    });
    const worst = Number(card.details[isLong ? APPROVED_PRICE_AT_MOST : APPROVED_PRICE_AT_LEAST]);
    expect(isLong ? Number(entry!.p) <= worst : Number(entry!.p) >= worst).toBe(true);
  } else {
    // Resting at the card's limit, which is the worst price it can ever fill at.
    expect(entry).toMatchObject({
      a: SOL.assetId,
      b: isLong,
      r: false,
      p: String(input.limitPrice),
      t: { limit: { tif: "Gtc" } },
    });
  }
  // The card's size at its price, rounded down onto the market's lot (0.01 SOL): never more.
  const price = input.limitPrice ?? SOL.markPx;
  const short = input.sizeUsd - Number(entry!.s) * price;
  expect(short).toBeGreaterThanOrEqual(-1e-9);
  expect(short).toBeLessThan(0.01 * price);
  // Only the position's own stops of a kind the card sets come off, and only by their ids.
  expect(world.posted.filter(({ type }) => type === "cancel")).toEqual(
    replaced.length > 0
      ? [{ type: "cancel", cancels: replaced.map(({ oid }) => ({ a: SOL.assetId, o: oid })) }]
      : [],
  );
}

holdsToCard("hyperliquid_order", {
  world: world_,
  asShown: {
    "a $50 long of SOL at 2x, with a stop-loss": {
      market: "SOL",
      side: "long",
      sizeUsd: 50,
      leverage: 2,
      stopLoss: 90,
    },
    "a $30 short of SOL at 3x": { market: "SOL", side: "short", sizeUsd: 30, leverage: 3 },
    "a $50 short with a stop-loss and a take-profit": {
      market: "SOL",
      side: "short",
      sizeUsd: 50,
      leverage: 2,
      stopLoss: 110,
      takeProfit: 80,
    },
    "a limit order to go long at $95, with a stop-loss and a take-profit": {
      market: "SOL",
      side: "long",
      sizeUsd: 50,
      leverage: 2,
      orderType: "limit",
      limitPrice: 95,
      stopLoss: 90,
      takeProfit: 120,
    },
  },
  paysAsShown: orderPaysAsShown,
  priceMoved: {
    "a long, once the mark rose past the worst price its card allowed": {
      input: { market: "SOL", side: "long", sizeUsd: 50, leverage: 2 },
      after: () => {
        world.markPx = 102;
      },
    },
    "a short, once the mark fell past the worst price its card allowed": {
      input: { market: "SOL", side: "short", sizeUsd: 30, leverage: 3 },
      after: () => {
        world.markPx = 98;
      },
    },
    "a long with a stop-loss, once the mark fell to the stop its card showed": {
      input: { market: "SOL", side: "long", sizeUsd: 50, leverage: 2, stopLoss: 99.5 },
      after: () => {
        world.markPx = 99.4;
      },
    },
  },
  takesMore: {
    never:
      "its margin is its card's size over its leverage, both from its input, which no quote sizes",
  },
  paysElsewhere: {
    never: "an order trades in the owner's own Hyperliquid account, which their wallet signs for",
  },
});

// The same move for a position that is open with stops of its own: a position has one of each
// kind, so the card's replace them, and the one it doesn't name stays.
holdsToCard("hyperliquid_order", {
  world() {
    world_();
    world.szi = "1";
    world.standing = [standingStop(11, "sl", "85"), standingStop(12, "tp", "130")];
  },
  asShown: {
    "adding $50 to a SOL long, moving its stop-loss": {
      market: "SOL",
      side: "long",
      sizeUsd: 50,
      leverage: 2,
      stopLoss: 90,
    },
    "adding $50 to it with no stops, which leaves the position's own": {
      market: "SOL",
      side: "long",
      sizeUsd: 50,
      leverage: 2,
    },
  },
  paysAsShown: orderPaysAsShown,
  priceMoved: {
    "an add, once the position it was drawn for has turned short": {
      input: { market: "SOL", side: "long", sizeUsd: 50, leverage: 2, stopLoss: 90 },
      after: () => {
        world.szi = "-1";
      },
    },
  },
  takesMore: { never: "as above: its input sizes it" },
  paysElsewhere: { never: "as above: it trades in the owner's own account" },
});

holdsToCard("hyperliquid_close", {
  world() {
    world_();
    world.szi = "1";
  },
  asShown: {
    "closing all of a SOL long": { market: "SOL" },
    "closing half of it": { market: "SOL", percent: 50 },
  },
  paysAsShown(signed, card) {
    expect(signed.evm).toEqual([]);
    const [close, ...others] = orders();
    expect(others).toEqual([]);
    // Selling back no more of the long than the card showed, at no less than its worst price.
    expect(close).toMatchObject({ a: SOL.assetId, b: false, r: true });
    expect(Number(close!.s)).toBeLessThanOrEqual(Number(card.details.closesUpTo));
    expect(Number(close!.p)).toBeGreaterThanOrEqual(Number(card.details[APPROVED_PRICE_AT_LEAST]));
  },
  priceMoved: {
    "closing a long, once the mark fell past the worst price its card allowed": {
      input: { market: "SOL" },
      after: () => {
        world.markPx = 98;
      },
    },
  },
  takesMore: {
    never:
      "a position that grew closes only what its card showed, and one that shrank what's left (position.test.ts)",
  },
  paysElsewhere: { never: "a close trades in the owner's own Hyperliquid account" },
});

holdsToCard("hyperliquid_set_stops", {
  world() {
    world_();
    world.szi = "1";
  },
  asShown: {
    "a stop-loss and take-profit on a long": { market: "SOL", stopLoss: 90, takeProfit: 120 },
  },
  paysAsShown(_signed, card) {
    // Orders that can only close the whole position, at the prices its card names, in one
    // request, and nothing else.
    const input = card.input as { stopLoss: number; takeProfit: number };
    expect(world.posted.map(({ type, grouping }) => grouping ?? type)).toEqual(["positionTpsl"]);
    expect(orders()).toEqual([
      wholePositionStop(true, "sl", input.stopLoss),
      wholePositionStop(true, "tp", input.takeProfit),
    ]);
  },
  priceMoved: {
    never: "it moves no money now: its stops close the position later, at its card's prices",
  },
  takesMore: { never: "its stops close the position it protects, and never open one" },
  paysElsewhere: { never: "its stops trade in the owner's own Hyperliquid account" },
});

holdsToCard("hyperliquid_withdraw", {
  world: world_,
  asShown: { "$30 of free cash": { amountUsd: 30 }, "all free cash": {} },
  paysAsShown(_signed, card) {
    // To the owner's own wallet, no more than the card showed.
    const withdrawals = world.posted.filter((action) => action.type === "withdraw3");
    expect(withdrawals).toEqual([
      expect.objectContaining({ destination: OWNER.evm.toLowerCase(), amount: card.amountUsd }),
    ]);
  },
  priceMoved: { never: "a withdrawal moves USDC dollar for dollar" },
  takesMore: {
    never:
      "it withdraws its card's amount, or what is left free when that is less (transfers.test.ts)",
  },
  paysElsewhere: { never: "it pays the owner's own address, which paysAsShown reads" },
});
