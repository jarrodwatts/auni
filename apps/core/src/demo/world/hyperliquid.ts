import { NETWORKS } from "@auni/shared";
import { encodeFunctionData, erc20Abi, getAddress, parseUnits, type Address } from "viem";

import { refuse, type Asked, type Service } from "../world.ts";
import { chains } from "./chain.ts";
import { STARTED, TODAY, usdOf, type AssetSymbol } from "./prices.ts";

// The demo's Hyperliquid: a small exchange that keeps one account, fills every order that
// crosses the mark in full, at the mark, and answers /info and /exchange as the real one does
// (apps/hyperliquid/api.ts). The account is unified, as Auni makes the owner's: its cash is
// spot USDC, whose total carries each position's profit and loss, and of which each isolated
// position holds its margin and each order waiting to open one holds the margin it would take.

/** Hyperliquid's bridge on Arbitrum, which pays withdrawals out. */
const BRIDGE = getAddress("0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7");
const FEE_RATE = 0.00045;
/** What the exchange keeps of every withdrawal, in dollars. */
const WITHDRAWAL_FEE = 1;
const HOUR_MS = 60 * 60_000;

interface Listed {
  readonly name: AssetSymbol;
  readonly szDecimals: number;
  readonly maxLeverage: number;
}

/** The main dex's markets, in the order their asset ids count them. */
const MARKETS: readonly Listed[] = [
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
  { name: "SOL", szDecimals: 2, maxLeverage: 20 },
];

interface Position {
  /** Coins held, below zero for a short. */
  size: number;
  entry: number;
  leverage: number;
  margin: number;
}

interface Fill {
  readonly coin: string;
  readonly px: string;
  readonly sz: string;
  readonly side: "B" | "A";
  readonly time: number;
  readonly startPosition: string;
  readonly dir: string;
  readonly closedPnl: string;
  readonly hash: string;
  readonly oid: number;
  readonly crossed: boolean;
  readonly fee: string;
  readonly tid: number;
  readonly cloid?: string;
  readonly feeToken: "USDC";
}

/** A stop on a coin's whole position, which the exchange holds whether or not one is open yet. */
interface Trigger {
  readonly coin: string;
  readonly oid: number;
  /** Buys to close a short, sells to close a long. */
  readonly isBuy: boolean;
  readonly triggerPx: number;
  readonly tpsl: "sl" | "tp";
  readonly cloid?: string;
}

/** An order waiting on the book for its price. */
interface Resting {
  readonly coin: string;
  readonly oid: number;
  readonly isBuy: boolean;
  readonly size: number;
  readonly limitPx: number;
  readonly reduceOnly: boolean;
  readonly placedAt: number;
  readonly cloid?: string;
}

interface OrderWire {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t: {
    readonly limit?: { readonly tif: string };
    readonly trigger?: { readonly triggerPx: string; readonly tpsl: "sl" | "tp" };
  };
  readonly c?: string;
}

/** The owner's account, as the exchange keeps it. */
const account = {
  /** Spot USDC, margins included, before what open positions have made or lost. */
  cash: 0,
  positions: new Map<string, Position>(),
  leverage: new Map<string, number>(),
  fills: [] as Fill[],
  triggers: [] as Trigger[],
  resting: [] as Resting[],
  /** What became of each order that is no longer open, by its id. */
  ended: new Map<number, { readonly order: object; readonly status: "filled" | "canceled" }>(),
  /** Its deposits and withdrawals, as userNonFundingLedgerUpdates lists them. */
  ledger: [] as { readonly time: number; readonly hash: string; readonly delta: object }[],
  ids: 0,
};

const mark = (coin: string, at?: number) => usdOf(coin as AssetSymbol, at);
const money = (value: number) => value.toFixed(6);

/** Circle's deposit wallet on HyperEVM, which the ledger names as the sender of a CCTP deposit. */
const CORE_DEPOSIT_WALLET = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";

/**
 * Credits `usdc` dollars that Circle's forwarder carried in by CCTP for `owner` (circle.ts), as
 * the real ledger lists it: a send from Circle's deposit wallet. Hyperliquid's bridge on Arbitrum
 * pays withdrawals from its own USDC, so the demo's holds what the account was credited.
 */
export function creditFromCircle(owner: Address, usdc: number): void {
  account.cash += usdc;
  chains.get("arbitrum")!.credit(NETWORKS.arbitrum.usdc, BRIDGE, parseUnits(money(usdc), 6));
  account.ledger.push({
    time: Date.now(),
    hash: `0x${(account.ledger.length + 1).toString(16).padStart(64, "0")}`,
    delta: {
      type: "send",
      user: CORE_DEPOSIT_WALLET,
      destination: owner.toLowerCase(),
      token: "USDC",
      amount: money(usdc),
    },
  });
}

/** Trades `size` coins of `coin` at `price` (the mark, unless given), opening, adding to or closing the position. */
function trade(
  coin: string,
  isBuy: boolean,
  size: number,
  oid: number,
  cloid?: string,
  price = mark(coin),
): Fill {
  const held = account.positions.get(coin) ?? {
    size: 0,
    entry: price,
    leverage: account.leverage.get(coin) ?? 1,
    margin: 0,
  };
  const signed = isBuy ? size : -size;
  const closes = held.size !== 0 && Math.sign(held.size) !== Math.sign(signed);
  const closed = closes ? Math.min(size, Math.abs(held.size)) : 0;
  const pnl = closed * (price - held.entry) * Math.sign(held.size);
  const fee = size * price * FEE_RATE;
  const after = held.size + signed;
  const dir = closes
    ? `Close ${held.size > 0 ? "Long" : "Short"}`
    : `Open ${isBuy ? "Long" : "Short"}`;
  const fill: Fill = {
    coin,
    px: String(Number(price.toPrecision(6))),
    sz: String(size),
    side: isBuy ? "B" : "A",
    time: Date.now(),
    startPosition: String(held.size),
    dir,
    closedPnl: money(pnl),
    hash: `0x${(++account.ids).toString(16).padStart(64, "0")}`,
    oid,
    crossed: true,
    fee: money(fee),
    tid: account.ids,
    feeToken: "USDC",
    ...(cloid ? { cloid } : {}),
  };
  account.cash += pnl - fee;
  if (Math.abs(after) < 1e-9) {
    account.positions.delete(coin);
    // A position's stops go with it, unless an order still waits to open more of it.
    if (!account.resting.some((order) => order.coin === coin && !order.reduceOnly))
      account.triggers = account.triggers.filter((trigger) => trigger.coin !== coin);
  } else if (closes) {
    account.positions.set(coin, {
      ...held,
      size: after,
      margin: held.margin * (Math.abs(after) / Math.abs(held.size)),
    });
  } else {
    const opened = Math.abs(held.size) + size;
    account.positions.set(coin, {
      size: after,
      entry: (Math.abs(held.size) * held.entry + size * price) / opened,
      leverage: held.leverage,
      margin: held.margin + (size * price) / held.leverage,
    });
  }
  account.fills.push(fill);
  return fill;
}

/**
 * What each order of one request came to: a stop taken for its coin's whole position, as Auni
 * sends every stop (apps/hyperliquid/stops.ts), and any other order filled, left resting, or
 * refused.
 */
function place(orders: readonly OrderWire[]): unknown[] {
  return orders.map((order) => {
    const market = MARKETS[order.a];
    if (!market) return { error: "Asset does not exist." };
    const oid = ++account.ids;
    if (order.t.trigger) {
      account.triggers.push({
        coin: market.name,
        oid,
        isBuy: order.b,
        triggerPx: Number(order.t.trigger.triggerPx),
        tpsl: order.t.trigger.tpsl,
        ...(order.c ? { cloid: order.c } : {}),
      });
      return "waitingForTrigger";
    }
    const price = mark(market.name);
    const crosses = order.b ? Number(order.p) >= price : Number(order.p) <= price;
    // One that may wait does, on a book the demo never fills from: it only shows the order placed.
    if (!crosses && order.t.limit?.tif === "Gtc") {
      // One that would open a position holds its margin while it waits, out of free cash.
      const holds = order.r
        ? 0
        : (Number(order.s) * Number(order.p)) / (account.leverage.get(market.name) ?? 1);
      if (holds > freeCash()) return { error: "Insufficient margin to place order." };
      account.resting.push({
        coin: market.name,
        oid,
        isBuy: order.b,
        size: Number(order.s),
        limitPx: Number(order.p),
        reduceOnly: order.r,
        placedAt: Date.now(),
        ...(order.c ? { cloid: order.c } : {}),
      });
      return { resting: { oid } };
    }
    if (!crosses) return { error: "Order could not immediately match against any resting orders." };
    const size = Number(order.s);
    const opening = !order.r;
    const leverage = account.leverage.get(market.name) ?? 1;
    if (opening && (size * price) / leverage > freeCash())
      return { error: "Insufficient margin to place order." };
    const fill = trade(market.name, order.b, size, oid, order.c);
    return { filled: { oid, totalSz: fill.sz, avgPx: fill.px } };
  });
}

/** A stop as frontendOpenOrders lists it: for a whole position, so with no size of its own. */
function listedStop(trigger: Trigger) {
  return {
    coin: trigger.coin,
    oid: trigger.oid,
    side: trigger.isBuy ? "B" : "A",
    sz: "0.0",
    origSz: "0.0",
    isTrigger: true,
    isPositionTpsl: true,
    reduceOnly: true,
    orderType: trigger.tpsl === "sl" ? "Stop Market" : "Take Profit Market",
    triggerPx: String(trigger.triggerPx),
    triggerCondition: "N/A",
    limitPx: String(trigger.triggerPx),
    timestamp: STARTED,
    children: [],
    tif: null,
    cloid: trigger.cloid ?? null,
  };
}

/** An order waiting on the book as frontendOpenOrders lists it. */
function listedOrder(order: Resting) {
  return {
    coin: order.coin,
    oid: order.oid,
    side: order.isBuy ? "B" : "A",
    sz: String(order.size),
    origSz: String(order.size),
    isTrigger: false,
    isPositionTpsl: false,
    reduceOnly: order.reduceOnly,
    orderType: "Limit",
    triggerPx: "0.0",
    triggerCondition: "N/A",
    limitPx: String(order.limitPx),
    timestamp: order.placedAt,
    children: [],
    tif: "Gtc",
    cloid: order.cloid ?? null,
  };
}

function unrealized(coin: string, position: Position): number {
  return position.size * (mark(coin) - position.entry);
}

/** What each position holds, its margin with what it has made or lost, by coin. */
const marginUsed = (coin: string, position: Position) =>
  position.margin + unrealized(coin, position);

/** Spot USDC's total, which in a unified account carries each position's profit and loss. */
const total = () =>
  [...account.positions].reduce(
    (sum, [coin, position]) => sum + unrealized(coin, position),
    account.cash,
  );

/** Spot USDC's hold: each position's margin, and what each order waiting to open one holds. */
const held = () =>
  [...account.positions].reduce((sum, [coin, position]) => sum + marginUsed(coin, position), 0) +
  account.resting
    .filter((order) => !order.reduceOnly)
    .reduce(
      (sum, order) => sum + (order.size * order.limitPx) / (account.leverage.get(order.coin) ?? 1),
      0,
    );

const freeCash = () => total() - held();

function info(body: Record<string, unknown>): unknown {
  switch (body.type) {
    case "perpDexs":
      return [null];
    case "userAbstraction":
      return "unifiedAccount";
    case "metaAndAssetCtxs":
      return [
        { universe: MARKETS, collateralToken: 0 },
        MARKETS.map(({ name }) => ({
          markPx: String(Number(mark(name).toPrecision(6))),
          midPx: String(Number(mark(name).toPrecision(6))),
          oraclePx: String(Number(mark(name).toPrecision(6))),
          // The demo's last day is today, from its midnight (world/prices.ts).
          prevDayPx: String(Number(mark(name, TODAY).toPrecision(6))),
          dayNtlVlm: "184000000.0",
          funding: "0.0000125",
          openInterest: "1000000.0",
          premium: "0.0",
        })),
      ];
    case "allMids":
      return mids();
    case "candleSnapshot": {
      const { coin, interval, startTime, endTime } = body.req as {
        coin: string;
        interval: string;
        startTime: number;
        endTime: number;
      };
      const step = interval.endsWith("m")
        ? Number.parseInt(interval) * 60_000
        : interval.endsWith("h")
          ? Number.parseInt(interval) * HOUR_MS
          : 24 * HOUR_MS;
      const candles = [];
      for (let open = Math.floor(startTime / step) * step; open < endTime; open += step) {
        const close = String(Number(mark(coin, Math.min(open + step, endTime)).toPrecision(6)));
        candles.push({
          t: open,
          T: open + step - 1,
          s: coin,
          i: interval,
          o: close,
          c: close,
          h: close,
          l: close,
          v: "0",
          n: 0,
        });
      }
      return candles;
    }
    case "spotClearinghouseState":
      return { balances: [{ coin: "USDC", total: money(total()), hold: money(held()) }] };
    case "clearinghouseState": {
      const positions = [...account.positions];
      // A unified account's dex is a view of spot's hold, which Hyperliquid says means nothing.
      return {
        withdrawable: "0.0",
        marginSummary: { accountValue: money(held()) },
        assetPositions: positions.map(([coin, position]) => {
          const market = MARKETS.find(({ name }) => name === coin)!;
          const maintenance = 1 / (2 * market.maxLeverage);
          const side = Math.sign(position.size);
          const liquidation = position.entry * (1 - side * (1 / position.leverage - maintenance));
          return {
            type: "oneWay",
            position: {
              coin,
              szi: String(position.size),
              entryPx: String(Number(position.entry.toPrecision(6))),
              positionValue: money(Math.abs(position.size) * mark(coin)),
              liquidationPx: String(Number(liquidation.toPrecision(6))),
              unrealizedPnl: money(unrealized(coin, position)),
              marginUsed: money(marginUsed(coin, position)),
              leverage: { type: "isolated", value: position.leverage },
              maxLeverage: market.maxLeverage,
            },
          };
        }),
      };
    }
    case "frontendOpenOrders":
      return [...account.triggers.map(listedStop), ...account.resting.map(listedOrder)];
    case "orderStatus": {
      const open = account.resting.find(({ oid }) => oid === body.oid);
      const ended = account.ended.get(body.oid as number);
      if (open) return { status: "order", order: { order: listedOrder(open), status: "open" } };
      return ended ? { status: "order", order: ended } : { status: "unknownOid" };
    }
    case "userFillsByTime": {
      const { startTime, endTime } = body as { startTime: number; endTime?: number };
      return account.fills.filter(
        ({ time }) => time >= startTime && time <= (endTime ?? Date.now()),
      );
    }
    case "userNonFundingLedgerUpdates":
      return account.ledger.filter(({ time }) => time >= Number(body.startTime ?? 0));
    default:
      return undefined;
  }
}

/**
 * Takes a withdrawal and pays it out as the real bridge does, from what deposits left in it:
 * the amount less the exchange's fee, to the address the owner signed for. The real one pays a
 * few minutes on; the demo's pays a second on, since a payout mined in the second it was asked
 * for could be dated before its own withdrawal. It is listed once paid, under the microseconds
 * of the time it was signed at.
 */
function withdraw(action: Record<string, unknown>): unknown {
  const usd = Number(action.amount);
  if (!(usd > WITHDRAWAL_FEE) || usd > freeCash() + 1e-9)
    return { status: "err", response: "Insufficient balance for withdrawal." };
  account.cash -= usd;
  setTimeout(() => {
    const hash = chains.get("arbitrum")!.send(BRIDGE, [
      {
        to: NETWORKS.arbitrum.usdc as Address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [
            getAddress(String(action.destination)),
            parseUnits((usd - WITHDRAWAL_FEE).toFixed(6), 6),
          ],
        }),
        value: 0n,
      },
    ]);
    account.ledger.push({
      time: Date.now(),
      hash,
      delta: {
        type: "withdraw",
        usdc: money(usd),
        nonce: Number(action.time) * 1_000,
        fee: money(WITHDRAWAL_FEE),
      },
    });
  }, 1_100).unref();
  return { status: "ok", response: { type: "default" } };
}

function exchange(action: Record<string, unknown>): unknown {
  const done = { status: "ok", response: { type: "default" } };
  switch (action.type) {
    case "userSetAbstraction":
      return done;
    case "cancelByCloid": {
      // Each stop by the tag it was sent with, which is how a move takes back one it just placed.
      const statuses = (action.cancels as readonly { readonly cloid: string }[]).map(
        ({ cloid }) => {
          if (!account.triggers.some((trigger) => trigger.cloid === cloid))
            return { error: "Order was never placed, already canceled, or filled." };
          account.triggers = account.triggers.filter((trigger) => trigger.cloid !== cloid);
          return "success";
        },
      );
      return { status: "ok", response: { type: "cancel", data: { statuses } } };
    }
    case "cancel": {
      // Each order by its id: one waiting on the book, or a stop; anything else was never
      // open, as the real one answers.
      const statuses = (action.cancels as readonly { readonly o: number }[]).map(({ o }) => {
        const order = account.resting.find(({ oid }) => oid === o);
        if (order) {
          account.resting = account.resting.filter(({ oid }) => oid !== o);
          account.ended.set(o, { order: listedOrder(order), status: "canceled" });
          return "success";
        }
        if (!account.triggers.some(({ oid }) => oid === o))
          return { error: "Order was never placed, already canceled, or filled." };
        account.triggers = account.triggers.filter(({ oid }) => oid !== o);
        return "success";
      });
      return { status: "ok", response: { type: "cancel", data: { statuses } } };
    }
    case "withdraw3":
      return withdraw(action);
    case "updateLeverage": {
      const market = MARKETS[action.asset as number];
      if (market) account.leverage.set(market.name, action.leverage as number);
      return done;
    }
    case "order":
      return {
        status: "ok",
        response: {
          type: "order",
          data: { statuses: place(action.orders as readonly OrderWire[]) },
        },
      };
    default:
      return {
        status: "err",
        response: `The demo's Hyperliquid doesn't take ${String(action.type)}.`,
      };
  }
}

/**
 * Fires a stop the owner's position carries, as the real exchange does when the mark reaches
 * it: the demo's "the venue did this by itself" (scenes.ts). False when the coin has no stop.
 */
export function fireStop(coin: string): boolean {
  const stop = account.triggers.find((trigger) => trigger.coin === coin && trigger.tpsl === "sl");
  const held = account.positions.get(coin);
  if (!stop || !held) return false;
  // It closes the whole position, whatever that has come to.
  trade(coin, stop.isBuy, Math.abs(held.size), stop.oid, stop.cloid, stop.triggerPx);
  return true;
}

/** How often the price stream says every market's price. */
const TICK_MS = 2_000;
/** A market the stream says lower for a moment: by what share of its price, and until when. */
const dips = new Map<string, { readonly share: number; readonly until: number }>();

/**
 * Has the price stream say `coin` a share lower for a tick or two, as a market dips and comes
 * back: what trips a watch on it (scenes.ts). Only the stream says so: nothing held is worth less.
 */
export function dip(coin: string, share: number): void {
  dips.set(coin, { share, until: Date.now() + 1.5 * TICK_MS });
}

/** Every market's price: as the stream says it now, with `dipped`, or as it is asked for. */
function mids(dipped = false): Record<string, string> {
  return Object.fromEntries(
    MARKETS.map(({ name }) => {
      const low = dipped ? dips.get(name) : undefined;
      const share = low && low.until >= Date.now() ? low.share : 0;
      return [name, String(Number((mark(name) * (1 - share)).toPrecision(6)))];
    }),
  );
}

/**
 * Hyperliquid's API: /info reads, /exchange takes what the owner's wallet signed, and its
 * socket says every market's price every two seconds to whoever subscribed (apps/prices).
 */
export const hyperliquid: Service = {
  hosts: ["api.hyperliquid.xyz"],
  socket(tell, closed) {
    let ticking: NodeJS.Timeout | undefined;
    closed.addEventListener("abort", () => clearInterval(ticking));
    return (said) => {
      const { method, subscription } = said as {
        method?: string;
        subscription?: { type?: string };
      };
      if (method !== "subscribe" || subscription?.type !== "allMids" || ticking) return;
      const tick = () => tell({ channel: "allMids", data: { mids: mids(true) } });
      tick();
      ticking = setInterval(tick, TICK_MS).unref();
    };
  },
  answer({ url, body }: Asked) {
    const asked = body as Record<string, unknown>;
    if (url.pathname === "/exchange") return exchange(asked.action as Record<string, unknown>);
    if (url.pathname !== "/info") return undefined;
    return (
      info(asked) ?? refuse(422, `The demo's Hyperliquid doesn't answer ${String(asked.type)}.`)
    );
  },
};
