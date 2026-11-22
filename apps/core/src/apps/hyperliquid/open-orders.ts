import { z } from "zod";

import { counted, defineTool, result } from "../../agent/tool.ts";
import { evmAddress } from "../../money/wallets.ts";
import { accountDexes, positionsOn } from "./account.ts";
import { info } from "./api.ts";
import { dexOf, findMarket } from "./markets.ts";

/** An order open on Hyperliquid, as it lists one (frontendOpenOrders). */
interface ListedOrder {
  readonly coin: string;
  /** B buys, A sells. */
  readonly side: "B" | "A";
  readonly limitPx: string;
  /** Coins still to fill, and the coins it was placed for. A stop on a whole position says "0.0". */
  readonly sz: string;
  readonly origSz: string;
  readonly oid: number;
  readonly timestamp: number;
  readonly isTrigger: boolean;
  /** The price a stop or take-profit fires at; "0.0" on a plain order. */
  readonly triggerPx: string;
  readonly reduceOnly: boolean;
  /** "Limit", "Stop Market", "Take Profit Market", and the limit forms of the last two. */
  readonly orderType: string;
  /** The tag it was sent with, if any (see orderTag). */
  readonly cloid?: string | null;
  /** The stops attached to it, which Hyperliquid places only once it has filled in full. */
  readonly children?: readonly ListedOrder[];
}

/** One order standing on Hyperliquid, as Auni reads it. */
export interface Standing {
  readonly oid: number;
  readonly market: string;
  /** An order waiting for its price, or a stop that closes a position once the mark reaches it. */
  readonly kind: "limit" | "stop-loss" | "take-profit";
  readonly isBuy: boolean;
  /** Whether it can only close a position, never open or add to one. */
  readonly reduceOnly: boolean;
  /** Coins still to fill. Null for a stop that closes its whole position, whatever its size then. */
  readonly size: string | null;
  /** Coins of it that have filled already. */
  readonly filled: string;
  /** The price it waits for: a limit order's limit, a stop's trigger. */
  readonly price: string;
  /**
   * The order a stop waits on, for one attached to an order in Hyperliquid's own app.
   * Hyperliquid lists it from the moment the order is placed, but places it only once that
   * order has filled in full: until then it protects nothing. Null for a stop that is in
   * place, and for a limit order.
   */
  readonly waitsOn: number | null;
  /** The tag it was sent with (see orderTag), which says which move of Auni's placed it. Null with none. */
  readonly tag: string | null;
  readonly placedAt: number;
}

function standing(order: ListedOrder, waitsOn: number | null): Standing {
  const [left, placedFor] = [Number(order.sz), Number(order.origSz)];
  return {
    oid: order.oid,
    market: order.coin,
    kind: !order.isTrigger
      ? "limit"
      : order.orderType.toLowerCase().startsWith("stop")
        ? "stop-loss"
        : "take-profit",
    isBuy: order.side === "B",
    reduceOnly: order.reduceOnly,
    size: left > 0 ? order.sz : null,
    // Coins, so the difference of two of Hyperliquid's decimals is cleared of float noise.
    filled: String(Number(Math.max(0, placedFor - left).toFixed(8))),
    price: order.isTrigger ? order.triggerPx : order.limitPx,
    waitsOn,
    tag: order.cloid ?? null,
    placedAt: order.timestamp,
  };
}

/**
 * Every order the owner has open on one perps dex ("" is the main one). A stop attached to an
 * order (as Hyperliquid's own app attaches one; Auni never does, see stops.ts) is listed twice
 * by Hyperliquid, under its order and on its own, looking there like a stop in place: here it
 * is listed once, naming the order it waits on.
 */
export async function standingOrders(user: string, dex: string): Promise<Standing[]> {
  const listed = await info<readonly ListedOrder[]>({
    type: "frontendOpenOrders",
    user,
    ...(dex === "" ? {} : { dex }),
  });
  const parents = new Map(
    listed.flatMap((order) => (order.children ?? []).map((child) => [child.oid, order.oid])),
  );
  const nested = listed.flatMap((order) => order.children ?? []);
  const seen = new Set(listed.map(({ oid }) => oid));
  return [...listed, ...nested.filter(({ oid }) => !seen.has(oid))].map((order) =>
    standing(order, parents.get(order.oid) ?? null),
  );
}

/**
 * The stops in place on a market's position now: orders that can only close it and wait on no
 * other order. They stand whether or not the position exists yet (see stops.ts). Given the
 * side a position is on (`closes`), only the stops that can close it: a long's sell, a short's
 * buy. A stop that trades the other way would never touch it.
 */
export function stopsInPlace(
  orders: readonly Standing[],
  market: string,
  closes?: "long" | "short",
) {
  const live = orders.filter(
    (order) =>
      order.market === market &&
      order.reduceOnly &&
      order.waitsOn === null &&
      (closes === undefined || order.isBuy === (closes === "short")),
  );
  return {
    stopLoss: live.filter(({ kind }) => kind === "stop-loss"),
    takeProfit: live.filter(({ kind }) => kind === "take-profit"),
  };
}

const openOrdersInput = {
  market: z
    .string()
    .min(1)
    .optional()
    .describe('One market, e.g. "BTC" or "xyz:NVDA". Leave it out for every market.'),
};

/** A stop as the lookup says it: where it fires, which side it closes, and how much of it. */
const stopOf = ({ oid, price, size, isBuy }: Standing) => ({
  order: String(oid),
  triggerPrice: price,
  closesA: isBuy ? "short" : "long",
  closes: size ?? "the whole position, whatever its size when it fires",
});

export const hyperliquidOpenOrders = defineTool({
  name: "hyperliquid_open_orders",
  description:
    "List what is open on the owner's Hyperliquid account: each limit order still waiting on the book, with how much of it has filled; each open position with the stop-loss and take-profit in place on it; and the stops standing on a market with no position yet, which close whatever fills of the orders waiting there, or are left over if no order waits. Read it to find the order to cancel, to check what protects a position before saying so, and to find a leftover stop to remove with hyperliquid_cancel_order.",
  inputSchema: openOrdersInput,
  async handler({ market }) {
    const owner = await evmAddress();
    if (!owner)
      return result(JSON.stringify({ orders: [], positions: [], stopsWithNoPosition: [] }));
    const only = market === undefined ? null : await findMarket(market);
    const dexes = only ? [dexOf(only.name)] : await accountDexes();
    const read = await Promise.all(
      dexes.map(async (dex) => ({
        orders: await standingOrders(owner, dex),
        positions: await positionsOn(owner, dex),
      })),
    );
    const wanted = <Row extends { readonly market: string }>(rows: readonly Row[]) =>
      rows.filter((row) => !only || row.market === only.name);
    const all = wanted(read.flatMap(({ orders }) => orders));
    const waiting = all.filter(({ kind }) => kind === "limit");
    const orders = waiting.map((order) => ({
      order: String(order.oid),
      market: order.market,
      does: `${order.isBuy ? "buys" : "sells"}${order.reduceOnly ? " to close only" : ""}`,
      limitPrice: order.price,
      stillToFill: order.size ?? "0",
      filledSoFar: order.filled,
      placedAt: new Date(order.placedAt).toISOString(),
      // Only on an order placed in Hyperliquid's own app: stops of the order's own, which
      // Hyperliquid places once the whole order has filled and which protect nothing until then.
      stopsWaitingOnIt: all.filter(({ waitsOn }) => waitsOn === order.oid).map(stopOf),
    }));
    const open = wanted(read.flatMap((each) => each.positions));
    const positions = open.map((position) => {
      const { stopLoss, takeProfit } = stopsInPlace(all, position.market, position.side);
      return {
        ...position,
        stopLossInPlace: stopLoss.map(stopOf),
        takeProfitInPlace: takeProfit.map(stopOf),
      };
    });
    // A position's stops rest on Hyperliquid before the position exists, beside the order that
    // will open it. With no such order either, they are left over from one that ended.
    const held = new Set(open.map((position) => position.market));
    const bare = [...new Set(all.map((order) => order.market))].filter((name) => !held.has(name));
    const stopsWithNoPosition = bare.flatMap((name) => {
      const { stopLoss, takeProfit } = stopsInPlace(all, name);
      if (stopLoss.length + takeProfit.length === 0) return [];
      const opens = waiting.some((order) => order.market === name && !order.reduceOnly);
      return [
        {
          market: name,
          stopLoss: stopLoss.map(stopOf),
          takeProfit: takeProfit.map(stopOf),
          protects: opens
            ? "whatever fills of the orders waiting on this market, from the first coin"
            : "nothing: left over from an order that ended. It would act on the next position opened here, so offer to remove it with hyperliquid_cancel_order.",
        },
      ];
    });
    return result(JSON.stringify({ orders, positions, stopsWithNoPosition }), {
      found: counted(orders.length, "order waiting", "orders waiting"),
    });
  },
});
