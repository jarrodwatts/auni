import { z } from "zod";

import type { ActionRow } from "../../db/schema.ts";
import {
  APPROVED_PRICE_AT_LEAST,
  APPROVED_PRICE_AT_MOST,
  approvedPrice,
} from "../../money/approved.ts";
import { priceLabel } from "../../money/format.ts";
import type { Recipe } from "../../money/recipe.ts";
import { dollars } from "../../money/summaries.ts";
import { evmAddress } from "../../money/wallets.ts";
import { readPosition } from "./account.ts";
import { closeFace, stopsFace } from "./card.ts";
import { findMarket, formatPrice, formatSize, MINIMUM_ORDER_USD, type Market } from "./markets.ts";
import { standingOrders } from "./open-orders.ts";
import { assertStopsBracket, entryWire, orderAction, placeOrder, stopTagsFrom } from "./orders.ts";
import { hyperliquidStatement } from "./statement.ts";
import {
  placeWholePositionStops,
  protectionNow,
  protectionOf,
  removeReplaced,
  stopsLeaveBare,
} from "./stops.ts";

const closeInput = {
  market: z.string().min(1).describe('Exact market, e.g. "BTC" or "xyz:NVDA".'),
  percent: z
    .number()
    .positive()
    .max(100)
    .default(100)
    .describe("How much of the position to close."),
  slippagePercent: z.number().positive().max(20).default(1),
};

/**
 * The open position's side and leverage, the coins closing `percent` of it
 * sells, what that share holds at today's price, the dollars it returns to
 * cash, and what it has made or lost, which closing locks in.
 */
async function closing(owner: string | null, market: Market, percent: number) {
  const position = owner ? await readPosition(owner, market) : null;
  if (!position) throw new Error(`There is no open ${market.name} position to close.`);
  const whole = position.szi.replace("-", "");
  const size =
    percent === 100 ? whole : formatSize((Number(whole) * percent) / 100, market.szDecimals);
  if (Number(size) <= 0)
    throw new Error(`${percent}% of the position is below ${market.name}'s smallest size.`);
  // Never less than nothing, however Hyperliquid reports the account.
  const share = Number(size) / Number(whole);
  const returnsUsd = Math.max(0, position.valueUsd * share);
  return {
    side: position.size > 0 ? ("long" as const) : ("short" as const),
    leverage: position.leverage,
    whole,
    size,
    sizeUsd: Number(size) * market.markPx,
    returnsUsd,
    pnlUsd: position.pnlUsd * share,
    entryPx: position.entryPx,
  };
}

/**
 * Refuses a part of a position Hyperliquid would turn away, before a card offers it: it takes no
 * order worth less than $10, valued at the lower of the mark and the order's worst price (as
 * sizeFor values an order), but closes a whole position at any size, since a reduce-only order
 * for exactly all of it is let under the minimum (docs.chainstack.com/docs/hyperliquid-order-precision,
 * read 2026-11-14; Hyperliquid's own list of refusals names the minimum and no exception). Live,
 * a card closing half of a $14 ETH long, about $6.93, was refused only once it was allowed.
 */
function assertPartTakes(
  market: Market,
  close: { readonly side: string; readonly whole: string; readonly size: string },
  percent: number,
  worst: string,
): void {
  const price = Math.min(market.markPx, Number(worst));
  const worth = (size: string) => Number(size) * price;
  if (percent === 100 || worth(close.size) >= MINIMUM_ORDER_USD) return;
  // The least whole percent of it that comes to $10 once rounded onto the market's lot, if any.
  const least = Array.from({ length: 99 }, (_, index) => index + 1).find(
    (part) =>
      worth(formatSize((Number(close.whole) * part) / 100, market.szDecimals)) >= MINIMUM_ORDER_USD,
  );
  throw new Error(
    `Hyperliquid takes no order worth less than $${MINIMUM_ORDER_USD}, and ${percent}% of your ${market.name} ${close.side} comes to about ${dollars(worth(close.size).toFixed(2))}. ` +
      `Close all of it, which Hyperliquid takes at any size, ${least ? `close at least ${least}% of it, ` : ""}or keep it as it is.`,
  );
}

/**
 * The worst price a close goes at: the mark less its slippage for a long, which it sells, or
 * more for a short, which it buys back. Once approved, it is held to the worst its card was
 * approved at, as an order's entry is, so a market that fell past it after the tap closes nothing.
 */
function exitPrice(
  market: Market,
  side: string,
  slippagePercent: number,
  approved: Pick<ActionRow, "details"> = { details: {} },
): string {
  const slip = slippagePercent / 100;
  const quoted = formatPrice(
    market.markPx * (side === "long" ? 1 - slip : 1 + slip),
    market.szDecimals,
    "nearest",
  );
  return approvedPrice(approved, { mark: market.markPx, quoted });
}

export const hyperliquidClose: Recipe<typeof closeInput> = {
  tool: "hyperliquid_close",
  description:
    "Close all or part of an open Hyperliquid perpetual position at market. Closing everything also takes off that position's stop-loss and take-profit, unless an order still waits to open more of it, which they stay on for.",
  input: closeInput,
  venue: "hyperliquid",
  // No direction: closing a perp always asks, like opening one.
  about: ({ input: close, details }) => ({
    kind: "perp",
    market: details.market ?? close.market,
    // A close previewed before it said what it closes has nothing to describe.
    ...((details.side === "long" || details.side === "short") && details.leverage
      ? {
          closes: {
            side: details.side,
            leverage: Number(details.leverage),
            sizeUsd: Number(details.sizeUsd),
            all: close.percent === 100,
            pnlUsd: Number(details.pnlUsd),
            ...(details.entryPx ? { entryUsd: Number(details.entryPx) } : {}),
          },
        }
      : {}),
  }),

  async describe(close, { heldTo }) {
    const [market, owner] = await Promise.all([findMarket(close.market), evmAddress()]);
    const [closes, open] = await Promise.all([
      closing(owner, market, close.percent),
      owner ? standingOrders(owner, market.dex) : [],
    ]);
    const { side, leverage, size, sizeUsd, returnsUsd, pnlUsd, entryPx } = closes;
    // The worst price it closes at, which execute never goes past.
    const worst = exitPrice(market, side, close.slippagePercent, heldTo);
    assertPartTakes(market, closes, close.percent, worst);
    return {
      summary: `Close ${close.percent === 100 ? "your" : `${close.percent}% of your`} ${market.name} position`,
      // Closing spends nothing: what the position is worth comes back to cash.
      amountUsd: "0",
      effect: {
        gives: [
          {
            text: `${close.percent === 100 ? "your" : `${close.percent}% of your`} ${leverage}x ${market.name} ${side} (${size} ${market.name})`,
            usd: sizeUsd,
          },
        ],
        gets: [
          { text: `about ${dollars(returnsUsd.toFixed(2))}`, lands: "in your Hyperliquid cash" },
        ],
        grants: [],
      },
      details: {
        // The market as it resolved: the input takes loose names like "btc".
        market: market.name,
        returnsUsd: returnsUsd.toFixed(2),
        // What the card closes, so a position that changes before the tap never closes more.
        side,
        closesUpTo: size,
        [side === "long" ? APPROVED_PRICE_AT_LEAST : APPROVED_PRICE_AT_MOST]: worst,
        // What the card says of it: "Your 3x long, down $4.63".
        leverage: String(leverage),
        sizeUsd: sizeUsd.toFixed(2),
        pnlUsd: pnlUsd.toFixed(2),
        // Where it was entered, which the move's story in Activity says beside where it closed.
        ...(entryPx === null ? {} : { entryPx: String(entryPx) }),
      },
      card: closeFace({
        market: market.name,
        side,
        percent: close.percent,
        size,
        worst: priceLabel(Number(worst)),
        pnlUsd,
        orderWaits: !protectionOf(open, market.name, false).leftOver,
      }),
    };
  },

  async execute({ action, input: close, wallets }) {
    const market = await findMarket(close.market);
    const { side, closesUpTo } = action.details;
    const worst =
      action.details[side === "long" ? APPROVED_PRICE_AT_LEAST : APPROVED_PRICE_AT_MOST];
    const now = await closing(wallets.evmAddress, market, close.percent);
    // Details without how much it closes, or the worst price it closes at, have nothing to hold
    // the tap to, so it asks again too.
    if (now.side !== side || closesUpTo === undefined || worst === undefined) {
      throw new Error(
        `This card no longer matches your ${market.name} position, so nothing was sent. Ask for a fresh card.`,
      );
    }
    // Never more than the card showed: a position that grew closes that, one that shrank what's left.
    const size = Number(now.size) < Number(closesUpTo) ? now.size : closesUpTo;
    const isLong = side === "long";
    const price = exitPrice(market, side, close.slippagePercent, action);
    const placed = await placeOrder(
      wallets,
      orderAction(
        [
          entryWire({
            market,
            isBuy: !isLong,
            price,
            size,
            reduceOnly: true,
            tif: "Ioc",
          }),
        ],
        "na",
        action.id,
      ),
    );
    if (!placed.filled) throw new Error("The close did not fill; the position is unchanged.");
    // What it sold is read from the statement, and split between whoever held it there.
    const closed = {
      txs: [],
      fills: [],
      statement: hyperliquidStatement(wallets.evmAddress),
    };
    if (close.percent < 100) return closed;
    // The close has filled, so tidying its stops never undoes it. With nothing held they would
    // act on the next position opened, unless an order still waits to open more of this one.
    const { position, protection } = await protectionNow(wallets.evmAddress, market).catch(() => ({
      position: null,
      protection: null,
    }));
    if (position !== null || protection?.leftOver === false) return closed;
    const left =
      protection === null
        ? "Its stop-loss and take-profit may still be on Hyperliquid."
        : await removeReplaced(wallets, market, [
            ...protection.stopLoss,
            ...protection.takeProfit,
          ]).then((failed) =>
            failed === null ? null : "Its stop-loss and take-profit may still be on Hyperliquid.",
          );
    return left ? { ...closed, note: left } : closed;
  },
};

const stopsInput = {
  market: z.string().min(1),
  stopLoss: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe("New stop-loss trigger price; null removes the current one; omit to leave it."),
  takeProfit: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe("New take-profit trigger price; null removes the current one; omit to leave it."),
};

export const hyperliquidSetStops: Recipe<typeof stopsInput> = {
  tool: "hyperliquid_set_stops",
  description:
    "Set, move or remove the stop-loss and take-profit on an open Hyperliquid position. A position has one of each, held by Hyperliquid: each closes the whole position at market when the mark price reaches it, however much the position has grown by then, so they need no setting again after adding to one.",
  input: stopsInput,
  venue: "hyperliquid",
  about: ({ input: stops, details }) => ({
    kind: "perp",
    market: details.market ?? stops.market,
    stops: {
      ...(stops.stopLoss === undefined ? {} : { stopLoss: stops.stopLoss }),
      ...(stops.takeProfit === undefined ? {} : { takeProfit: stops.takeProfit }),
    },
    ...(details.markPx ? { markUsd: Number(details.markPx) } : {}),
  }),

  // Each stop it sets is an order resting on Hyperliquid's book that closes the position later;
  // one it removes grants nothing. The position is read as execute reads it, so its card names
  // it and says the price now, and one execute would refuse is never offered.
  async describe(stops) {
    const owner = await evmAddress();
    const { market, isLong } = await protecting(owner, stops);
    const { stopLoss, takeProfit } = owner
      ? protectionOf(await standingOrders(owner, market.dex), market.name, true)
      : { stopLoss: [], takeProfit: [] };
    const price = (stop: number | null | undefined) =>
      typeof stop === "number" ? priceLabel(stop) : stop;
    const was = ([old]: readonly { readonly price: string }[]) =>
      old ? priceLabel(Number(old.price)) : null;
    const set = (price: number | null | undefined, does: string) =>
      typeof price === "number"
        ? [
            {
              lets: `Hyperliquid ${does} at market at ${priceLabel(price)}`,
              reach: "venue" as const,
            },
          ]
        : [];
    return {
      summary: `Update the stops on your ${market.name} position`,
      amountUsd: "0",
      effect: {
        gives: [],
        gets: [],
        grants: [
          ...set(stops.stopLoss, `close your ${market.name} position`),
          ...set(stops.takeProfit, "take profit on it"),
        ],
      },
      // The market as it resolved, and its price as the card says it, beside which the stops sit.
      details: { market: market.name, markPx: String(market.markPx) },
      card: stopsFace({
        market: market.name,
        side: isLong ? "long" : "short",
        stopLoss: price(stops.stopLoss),
        takeProfit: price(stops.takeProfit),
        stopLossWas: was(stopLoss),
        takeProfitWas: was(takeProfit),
        now: priceLabel(market.markPx),
      }),
    };
  },

  async execute({ action, input: stops, wallets }) {
    const { market, isLong, next } = await protecting(wallets.evmAddress, stops);
    // The position's stops now, of each kind this move names: a position has one of each, so
    // they come off once the new ones are on, and it is never left bare.
    const { protection } = await protectionNow(wallets.evmAddress, market);
    const replaced = [
      ...(stops.stopLoss === undefined ? [] : protection.stopLoss),
      ...(stops.takeProfit === undefined ? [] : protection.takeProfit),
    ];
    const placed = await placeWholePositionStops(
      wallets,
      market,
      isLong,
      next,
      { actionId: action.id, first: stopTagsFrom(action.attempts, 0) },
      "Your stops are as they were.",
    );
    const stuck = await removeReplaced(wallets, market, replaced);
    // With no new stop on, a removal that didn't go changed nothing: it fails, to be tried again.
    if (stuck && placed.length === 0) throw new Error(stuck);
    return { txs: [], fills: [], ...(stuck ? { note: stuck } : {}) };
  },
};

/**
 * The open position a change of stops is for and the stops it sets, refused when there is
 * nothing to change, no position to protect, a stop on the side of the price that would fire
 * at once, or stops that would leave an order waiting on the market bare (see stopsLeaveBare).
 */
async function protecting(
  owner: string | null,
  stops: {
    readonly market: string;
    readonly stopLoss?: number | null;
    readonly takeProfit?: number | null;
  },
) {
  if (stops.stopLoss === undefined && stops.takeProfit === undefined) {
    throw new Error("Name a stopLoss or takeProfit to set (or null to remove one).");
  }
  const market = await findMarket(stops.market);
  const position = owner ? await readPosition(owner, market) : null;
  if (!position) throw new Error(`There is no open ${market.name} position to protect.`);
  const isLong = position.size > 0;
  const next = {
    stopLoss: stops.stopLoss ?? undefined,
    takeProfit: stops.takeProfit ?? undefined,
  };
  assertStopsBracket(isLong, market.markPx, next);
  const bare = stopsLeaveBare(market, isLong, next, await standingOrders(owner!, market.dex));
  if (bare) throw new Error(bare);
  return { market, isLong, next };
}
