import { z } from "zod";

import type { ActionRow } from "../../db/schema.ts";
import {
  APPROVED_PRICE_AT_LEAST,
  APPROVED_PRICE_AT_MOST,
  approvedPrice,
} from "../../money/approved.ts";
import { formatAmount, priceLabel, usdLabel } from "../../money/format.ts";
import { MayHaveSent, type Recipe } from "../../money/recipe.ts";
import { evmAddress } from "../../money/wallets.ts";
import { ensureUnifiedAccount, setLeverage } from "./account.ts";
import { orderFace } from "./card.ts";
import { findMarket, formatPrice, type Market } from "./markets.ts";
import { saidThen } from "./problems.ts";
import {
  assertStopsBracket,
  entryWire,
  orderAction,
  placeOrder,
  sizeFor,
  stopTagsFrom,
} from "./orders.ts";
import type { Standing } from "./open-orders.ts";
import { hyperliquidStatement } from "./statement.ts";
import {
  placeWholePositionStops,
  protectionNow,
  removeReplaced,
  replacedBy,
  stopsLeaveBare,
  stopWords,
  takeBackStops,
} from "./stops.ts";

const input = {
  market: z
    .string()
    .min(1)
    .describe('Exact market from hyperliquid_markets, e.g. "BTC" or "xyz:NVDA".'),
  side: z.enum(["long", "short"]),
  sizeUsd: z
    .number()
    .positive()
    .describe("Position size (notional) in USD, not margin. Minimum $10."),
  leverage: z.number().int().min(1).describe("Whole multiple, at most the market's max leverage."),
  orderType: z.enum(["market", "limit"]).default("market"),
  limitPrice: z
    .number()
    .positive()
    .optional()
    .describe("Required for a limit order. On a market order it is the worst fill price allowed."),
  slippagePercent: z
    .number()
    .positive()
    .max(20)
    .default(1)
    .describe("Market orders only: worst fill allowed, as a percent from the mark price."),
  stopLoss: z
    .number()
    .positive()
    .optional()
    .describe(
      "The position's stop-loss: the price at which Hyperliquid closes the whole position at market. It replaces any stop-loss the position has.",
    ),
  takeProfit: z
    .number()
    .positive()
    .optional()
    .describe(
      "The position's take-profit, as stopLoss. On a limit order it must also be past the price now, not only past the limit.",
    ),
};

/**
 * The entry as execute sends it: its side, worst price, and size in coins.
 * Once approved, its worst price is held to the one its card was approved at.
 */
type Order = z.infer<z.ZodObject<typeof input>>;

function entryOf(
  market: Market,
  order: Order,
  approved: Pick<ActionRow, "details"> = { details: {} },
) {
  const isLong = order.side === "long";
  const reference = order.limitPrice ?? market.markPx;
  const quoted =
    order.limitPrice !== undefined
      ? formatPrice(order.limitPrice, market.szDecimals, isLong ? "down" : "up")
      : formatPrice(
          market.markPx *
            (isLong ? 1 + order.slippagePercent / 100 : 1 - order.slippagePercent / 100),
          market.szDecimals,
          "nearest",
        );
  const price = approvedPrice(approved, { mark: market.markPx, quoted });
  return {
    isLong,
    price,
    size: sizeFor(market, order.sizeUsd, reference, Number(price)),
  };
}

/**
 * Refuses an order this market can't take, before anything is signed: more leverage than it
 * allows, margin in a token Auni can't fund, a limit order with no price, a stop on the side of
 * the price that would fire at once, stops on an order that trades against the position `held`
 * (its signed size; null with none), or stops that would leave an order `waiting` on the
 * market bare (see stopsLeaveBare). The order's stops, when it stands.
 */
function orderable(
  market: Market,
  order: Order,
  held: number | null,
  waiting: readonly Standing[],
) {
  if (order.leverage > market.maxLeverage) {
    throw new Error(`${market.name} allows at most ${market.maxLeverage}x leverage.`);
  }
  // Free cash is USDC, so it can't margin a market that settles in USDH or USDe.
  if (market.collateralToken !== 0) {
    throw new Error(
      `${market.name} margins in a token other than USDC, and Auni can only fund USDC-margined Hyperliquid markets.`,
    );
  }
  if (order.orderType === "limit" && order.limitPrice === undefined) {
    throw new Error("A limit order needs limitPrice.");
  }
  const isLong = order.side === "long";
  const stops = { stopLoss: order.stopLoss, takeProfit: order.takeProfit };
  const any = stops.stopLoss !== undefined || stops.takeProfit !== undefined;
  // Stops protect the position, and this order shrinks or closes the one held.
  if (any && held !== null && held > 0 !== isLong) {
    throw new Error(
      `There is an open ${market.name} ${held > 0 ? "long" : "short"}, which this order trades against, so it can't set a stop-loss or take-profit. Send it without them, or close the position first.`,
    );
  }
  const bare = stopsLeaveBare(market, isLong, stops, waiting);
  if (bare) throw new Error(bare);
  assertStopsBracket(isLong, order.limitPrice ?? market.markPx, stops);
  // The stops rest on Hyperliquid from the moment the order is sent, not from when it fills,
  // so each must be past the price now as well as past the limit.
  if (order.limitPrice !== undefined) {
    try {
      assertStopsBracket(isLong, market.markPx, stops);
    } catch (error) {
      throw saidThen(
        error as Error,
        "A limit order's stops rest on Hyperliquid from the moment it is placed. Leave this one off, and set it with hyperliquid_set_stops once the order has filled.",
      );
    }
  }
  return stops;
}

/**
 * How far the price can go against an isolated position before Hyperliquid
 * liquidates it, as a share of the entry: its margin less the maintenance
 * margin, which is half the margin at the market's max leverage. That's the
 * base margin tier, which holds until a position runs into the millions.
 */
export function liquidationMove(isLong: boolean, leverage: number, maxLeverage: number): number {
  const maintenance = 1 / (2 * maxLeverage);
  return (1 / leverage - maintenance) / (1 + (isLong ? -maintenance : maintenance));
}

export const hyperliquidOrder: Recipe<typeof input> = {
  tool: "hyperliquid_order",
  description:
    "Open or add to a Hyperliquid perpetual position (crypto, and HIP-3 stocks and commodities like xyz:NVDA or xyz:GOLD), at market or as a resting limit, with an optional stop-loss and take-profit. Every position is isolated, risking only its own margin, which comes from the account's free USDC on Hyperliquid. A limit order rests until the market reaches it or hyperliquid_cancel_order takes it off the book. " +
    "A stop belongs to the position, not the order: Hyperliquid holds it for the whole position from the moment the order is sent, before anything fills, so whatever fills is protected whether or not Auni is running. A position has one stop-loss and one take-profit, so stops given here replace the position's own, and the card says so.",
  input,
  venue: "hyperliquid",
  // No direction: leverage can lose more than the margin a pot budgets, so it always asks.
  fundedFrom: () => "hyperliquid",
  about: ({ input: order, details }) => ({
    kind: "perp",
    market: details.market ?? order.market,
    opens: {
      side: order.side,
      leverage: order.leverage,
      sizeUsd: order.sizeUsd,
      ...(details.liquidationMove ? { liquidationMove: Number(details.liquidationMove) } : {}),
    },
    stops: {
      ...(order.stopLoss === undefined ? {} : { stopLoss: order.stopLoss }),
      ...(order.takeProfit === undefined ? {} : { takeProfit: order.takeProfit }),
    },
  }),

  async describe(order, { heldTo }) {
    const [market, owner] = await Promise.all([findMarket(order.market), evmAddress()]);
    const { position, orders, protection } = await protectionNow(owner, market);
    // Refused here as execute refuses it, so no card is made for an order that can't go.
    const stops = orderable(market, order, position?.size ?? null, orders);
    // Sized as execute sends it, so an order under Hyperliquid's $10 minimum is never offered.
    const entry = entryOf(market, order, heldTo);
    const price = order.limitPrice ?? market.markPx;
    const size = usdLabel(order.sizeUsd);
    const margin = order.sizeUsd / order.leverage;
    const stopLoss = order.stopLoss === undefined ? null : priceLabel(order.stopLoss);
    const takeProfit = order.takeProfit === undefined ? null : priceLabel(order.takeProfit);
    const rests = order.orderType === "limit";
    // Orders left resting on Hyperliquid's book, which it fills later on the account's cash. Each
    // names its market, since a plan says them apart from the move they belong to. A stop is the
    // position's, so on one already open it covers what is held now from the start.
    const whole = `your whole ${market.name} ${order.side}${position ? ", the part you hold now included," : ""}`;
    const resting = [
      ...(rests
        ? [
            `Hyperliquid fill your ${market.name} ${order.side} at ${priceLabel(price)} or better until you cancel`,
          ]
        : []),
      ...(stopLoss
        ? [`Hyperliquid close ${whole} at market if ${market.name} reaches ${stopLoss}`]
        : []),
      ...(takeProfit ? [`Hyperliquid take profit on ${whole} at market at ${takeProfit}`] : []),
    ].map((lets) => ({ lets, reach: "venue" as const, order: true as const }));
    // How far the price can go against the position before it is liquidated (see about).
    const wipedOut = liquidationMove(order.side === "long", order.leverage, market.maxLeverage);
    // The stops in place now that its own replace, and those left over that come off with them.
    const replaced = replacedBy(protection, stops);
    const was = (kind: "stop-loss" | "take-profit", set: number | undefined) => {
      const old = replaced.find((stop) => stop.kind === kind);
      return set !== undefined && old ? priceLabel(Number(old.price)) : null;
    };
    const words = {
      market: market.name,
      side: order.side,
      leverage: order.leverage,
      size,
      limit: rests ? priceLabel(price) : null,
      liquidationMove: wipedOut,
      stopLoss,
      takeProfit,
      stopLossWas: was("stop-loss", order.stopLoss),
      takeProfitWas: was("take-profit", order.takeProfit),
      comeOff: replaced
        .filter(({ kind }) => (kind === "stop-loss" ? !stopLoss : !takeProfit))
        .map(stopWords),
      adds: position !== null,
    };
    return {
      summary: `${rests ? "Place a limit order to go" : "Go"} ${order.side} ${market.name} with ${size} at ${order.leverage}x`,
      amountUsd: margin.toFixed(2),
      // Signed by the owner's own address over fields Auni's code builds, on their own account.
      effect: {
        gives: [{ text: `${usdLabel(margin)} of your Hyperliquid cash as margin` }],
        gets: [
          {
            text: `a ${size} ${market.name} ${order.side} at ${order.leverage}x (about ${formatAmount(order.sizeUsd / price)} ${market.name})`,
            lands: rests ? "on Hyperliquid once it fills" : "on Hyperliquid",
          },
        ],
        grants: resting,
      },
      // The market as it resolved: the input takes loose names like "btc". A market order also
      // keeps the worst price it enters at now, which execute never goes past (see approvedPrice);
      // a resting limit order's worst price is its limit.
      details: {
        market: market.name,
        liquidationMove: String(wipedOut),
        ...(rests
          ? {}
          : {
              [order.side === "long" ? APPROVED_PRICE_AT_MOST : APPROVED_PRICE_AT_LEAST]:
                entry.price,
            }),
      },
      card: orderFace(words),
    };
  },

  async execute({ action, input: order, wallets, posting }) {
    const market = await findMarket(order.market);
    const { position, orders, protection } = await protectionNow(wallets.evmAddress, market);
    const stops = orderable(market, order, position?.size ?? null, orders);
    const { isLong, price, size } = entryOf(market, order, action);

    await ensureUnifiedAccount(wallets);
    await setLeverage(wallets, market, order.leverage);
    // The stops go first, for the whole position, so they are in place before the first coin
    // of the entry can fill. The entry is tagged first of the action's orders, for life; the
    // stops after it, anew for each attempt (see stopTagsFrom).
    const tags = await placeWholePositionStops(
      wallets,
      market,
      isLong,
      stops,
      { actionId: action.id, first: stopTagsFrom(action.attempts, 1) },
      "The order was not sent, so nothing was opened.",
    );
    const entry = entryWire({
      market,
      isBuy: isLong,
      price,
      size,
      reduceOnly: false,
      tif: order.orderType === "limit" ? "Gtc" : "Ioc",
    });
    const placed = await posting("hyperliquid", () =>
      placeOrder(wallets, orderAction([entry], "na", action.id)),
    ).catch(async (error: unknown) => {
      // No answer: the order may be on the book, so its stops stay, to close whatever fills.
      if (error instanceof MayHaveSent || tags.length === 0) throw error;
      // Refused, so nothing was opened: the stops sent ahead of it would be left behind.
      throw saidThen(
        error instanceof Error ? error : new Error(String(error)),
        (await takeBackStops(wallets, market, tags)) ??
          "The stops sent ahead of it were taken off again.",
      );
    });
    // The position's earlier stops come off last, so it is never without one.
    const note = await removeReplaced(wallets, market, replacedBy(protection, stops));
    return {
      txs: [],
      fills: [],
      // What filled is read from the statement; a resting order's fills are, as they come.
      ...(placed.filled ? { statement: hyperliquidStatement(wallets.evmAddress) } : {}),
      ...(note ? { note } : {}),
    };
  },
};
