import { withArticle } from "@auni/shared";
import { z } from "zod";

import { formatAmount, priceLabel } from "../../money/format.ts";
import type { Recipe, Signer } from "../../money/recipe.ts";
import { evmAddress } from "../../money/wallets.ts";
import { cancelOrders } from "./account.ts";
import { info } from "./api.ts";
import { cancelFace, leftoverFace } from "./card.ts";
import { tickerOf } from "./keys.ts";
import { findMarket, type Market } from "./markets.ts";
import type { Standing } from "./open-orders.ts";
import { NOT_OPEN, refusal } from "./problems.ts";
import { protectionNow, protectionOf, removeReplaced, stopWords } from "./stops.ts";

const input = {
  market: z
    .string()
    .min(1)
    .describe('The order\'s market, as hyperliquid_open_orders names it, e.g. "BTC".'),
  order: z.string().regex(/^\d+$/u).describe("The order's id, from hyperliquid_open_orders."),
};

/** What Hyperliquid says became of an order (orderStatus): its last state, and the coins of it that filled. */
interface OrderNow {
  /** "open", "filled", "canceled", or one of Hyperliquid's other words for an order that ended. */
  readonly status: string;
  readonly filled: number;
}

/** What became of an order by its id, as Hyperliquid has it now; null for one it doesn't know. */
async function orderNow(user: string, oid: number): Promise<OrderNow | null> {
  const answer = await info<{
    readonly order?: {
      readonly status: string;
      readonly order: { readonly sz: string; readonly origSz: string };
    };
  }>({ type: "orderStatus", user, oid });
  if (!answer.order) return null;
  const { sz, origSz } = answer.order.order;
  return { status: answer.order.status, filled: Number((Number(origSz) - Number(sz)).toFixed(8)) };
}

/** What had already become of an order Hyperliquid wouldn't cancel, for the owner. */
function became(now: OrderNow | null, coin: string): string | undefined {
  if (now?.status === "filled")
    return "It had already filled in full, and what it traded is in your position.";
  if (now && /cancel/iu.test(now.status))
    return now.filled > 0
      ? `It had already been cancelled, after ${formatAmount(now.filled)} ${coin} of it filled, which is in your position.`
      : "It had already been cancelled, with none of it filled.";
  return undefined;
}

/** Every stop in place on a market's position. */
const inPlace = ({ stopLoss, takeProfit }: ReturnType<typeof protectionOf>) => [
  ...stopLoss,
  ...takeProfit,
];

export const hyperliquidCancelOrder: Recipe<typeof input> = {
  tool: "hyperliquid_cancel_order",
  description:
    "Cancel a limit order still waiting on Hyperliquid's book, by its id from hyperliquid_open_orders. Nothing is bought or sold. Any part of it that has already filled stays open as the position, and keeps the position's stop-loss and take-profit. When nothing has filled and no other order waits on that market, the stops sent with the order come off with it, and the card says so. " +
    "It also removes a stop that hyperliquid_open_orders lists as left over (one with no position and no order for it to protect), by that stop's id. A stop-loss or take-profit on an open position is not cancelled here: hyperliquid_set_stops removes one.",
  input,
  venue: "hyperliquid",
  about: ({ input: cancel, details }) => ({
    kind: "perp",
    market: details.market ?? cancel.market,
  }),

  async describe(cancel) {
    const [market, owner] = await Promise.all([findMarket(cancel.market), evmAddress()]);
    const { position, orders: open } = await protectionNow(owner, market);
    const order = open.find(({ oid }) => String(oid) === cancel.order);
    if (order?.market !== market.name) {
      throw new Error(
        `There is no open order ${cancel.order} on ${market.name}. It may have filled or been cancelled already.`,
      );
    }
    const coin = tickerOf(market.name);
    if (order.kind !== "limit") return describeLeftover(market, order, open, position !== null);
    // An order that opens or adds to a position reads as the owner asked for it, long or short;
    // one that can only close, or that trades against the position, as what it does: buy or sell.
    const opens = !order.reduceOnly && (!position || position.size > 0 === order.isBuy);
    const does = opens ? `go ${order.isBuy ? "long" : "short"}` : order.isBuy ? "buy" : "sell";
    const filled =
      Number(order.filled) > 0 ? `${formatAmount(Number(order.filled))} ${coin}` : null;
    // The position's stops once this order is gone: with nothing held and nothing else waiting
    // to open, they would be left behind to act on a later position, so they come off with it.
    const after = protectionOf(
      open.filter(({ oid }) => oid !== order.oid),
      market.name,
      position !== null,
    );
    const stops = inPlace(after);
    return {
      summary: `Cancel your order to ${does} ${coin} on Hyperliquid`,
      // It moves no money: the order comes off the book, and nothing is bought or sold.
      amountUsd: "0",
      effect: { gives: [], gets: [], grants: [] },
      // The order its card showed, which is the only one execute cancels, and the stops it said
      // come off with it, which are the only ones execute takes off.
      details: {
        market: market.name,
        order: String(order.oid),
        filled: order.filled,
        ...(after.leftOver && stops.length > 0
          ? { stops: stops.map(({ oid }) => oid).join(",") }
          : {}),
      },
      card: cancelFace({
        market: market.name,
        does,
        waiting: `${formatAmount(Number(order.size ?? "0"))} ${coin}`,
        price: priceLabel(Number(order.price)),
        filled,
        stops: stops.map(stopWords),
        stopsStayFor: after.leftOver ? null : position ? "position" : "order",
        attached: open.filter(({ waitsOn }) => waitsOn === order.oid).map(stopWords),
      }),
    };
  },

  async execute({ action, wallets }) {
    // Held to the order its card showed, whatever the input says by now.
    const { market: named, order } = action.details;
    if (!named || !order) {
      throw new Error(
        "This card doesn't say which order it cancels, so nothing was sent. Ask for a fresh card.",
      );
    }
    const market = await findMarket(named);
    const oid = Number(order);
    const coin = tickerOf(market.name);
    if (action.details.leftover) return removeLeftover(wallets, market, oid);
    const whatBecame = () => orderNow(wallets.evmAddress, oid).catch(() => null);
    // An order that has gone since its card is refused before anything is signed.
    const before = await orderNow(wallets.evmAddress, oid);
    if (before?.status !== "open") throw refusal(NOT_OPEN, became(before, coin));
    const [refusedWhy] = await cancelOrders(wallets, market, [oid]).catch(
      async (error: unknown) => {
        // No answer from Hyperliquid. A cancel moves no money, and the order itself says whether
        // it went: cancelled is done, and anything else fails as it is, to be tried again.
        if (/cancel/iu.test((await whatBecame())?.status ?? "")) return [];
        throw error;
      },
    );
    // It was open a moment ago, so Hyperliquid refusing means it filled or was cancelled since.
    if (refusedWhy !== undefined) throw refusal(refusedWhy, became(await whatBecame(), coin));
    // More of it may have filled between the read above and the cancel, so it is read once
    // more; filled coins only grow, so the read above is the least it can be.
    const filled = (await whatBecame())?.filled ?? before.filled;
    const shown = new Set((action.details.stops ?? "").split(",").filter(Boolean).map(Number));
    if (filled === 0 && shown.size === 0) return { txs: [], fills: [] };
    // What stands now decides what becomes of the stops: a part that filled keeps them, and
    // with nothing held and nothing waiting, those the card showed come off.
    const { protection } = await protectionNow(wallets.evmAddress, market);
    const stops = inPlace(protection);
    const kept =
      filled === 0
        ? null
        : `${formatAmount(filled)} ${coin} of the order had filled before it was cancelled, and stays open as your position. ${
            stops.length > 0
              ? `It keeps its ${stops.map(stopWords).join(" and ")}.`
              : "It has no stop-loss or take-profit."
          }`;
    const left = protection.leftOver
      ? await removeReplaced(
          wallets,
          market,
          stops.filter((stop) => shown.has(stop.oid)),
        ).then((failed) =>
          failed === null
            ? null
            : `The stops sent with the order could not be taken off, and may still be on Hyperliquid, where they would act on the next ${coin} position you open.`,
        )
      : null;
    const note = [kept, left].filter(Boolean).join(" ");
    return { txs: [], fills: [], ...(note ? { note } : {}) };
  },
};

/** The card for taking off a stop with nothing to protect, refused for any other stop. */
function describeLeftover(
  market: Market,
  stop: Standing,
  open: readonly Standing[],
  held: boolean,
) {
  if (stop.waitsOn !== null) {
    throw new Error(
      `That ${stop.kind} waits on order ${stop.waitsOn} and is cancelled with it. Cancel that order instead.`,
    );
  }
  if (!protectionOf(open, market.name, held).leftOver) {
    throw new Error(
      held
        ? `That is the ${stop.kind} in place on the position. Changing the position's stops with hyperliquid_set_stops removes it.`
        : `That ${stop.kind} is there for an order still waiting on ${market.name}, and closes whatever of it fills. Cancelling that order takes it off.`,
    );
  }
  const coin = tickerOf(market.name);
  return {
    summary: `Remove a leftover ${stop.kind} on ${coin} from Hyperliquid`,
    amountUsd: "0",
    effect: { gives: [], gets: [], grants: [] },
    details: { market: market.name, order: String(stop.oid), leftover: stop.kind },
    card: leftoverFace({
      market: market.name,
      kind: stop.kind,
      price: priceLabel(Number(stop.price)),
    }),
  };
}

/**
 * Takes the card's leftover stop off, if it is still there with nothing to protect: one that a
 * position or an order has come to need since the card stays where it is.
 */
async function removeLeftover(wallets: Signer, market: Market, oid: number) {
  const { protection } = await protectionNow(wallets.evmAddress, market);
  const stop = inPlace(protection).find((standing) => standing.oid === oid);
  if (!stop) throw refusal(NOT_OPEN, "It had already gone from Hyperliquid.");
  if (!protection.leftOver) {
    throw new Error(
      `There is ${withArticle(market.name)} position or order now, which this stop protects, so nothing was sent. Ask for a fresh card.`,
    );
  }
  const [refusedWhy] = await cancelOrders(wallets, market, [oid]);
  if (refusedWhy !== undefined) throw refusal(refusedWhy, "It had already gone from Hyperliquid.");
  return { txs: [], fills: [] };
}
