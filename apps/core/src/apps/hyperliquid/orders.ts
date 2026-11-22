import { MayHaveSent, type Signer } from "../../money/recipe.ts";
import type { Exit } from "../../money/venue-statement.ts";
import { sendL1 } from "./api.ts";
import { formatPrice, formatSize, MINIMUM_ORDER_USD, type Market } from "./markets.ts";
import { refusal } from "./problems.ts";

// A triggered market stop still carries a limit price; it caps the fill 10% past the trigger.
const STOP_FILL_ROOM = 0.1;

interface OrderWire {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t:
    | { readonly limit: { readonly tif: "Gtc" | "Ioc" } }
    | {
        readonly trigger: {
          readonly isMarket: boolean;
          readonly triggerPx: string;
          readonly tpsl: "tp" | "sl";
        };
      };
  /** Its tag (see orderTag): last, as Hyperliquid hashes the keys in order. */
  readonly c?: string;
}

interface OrderAction {
  readonly type: "order";
  readonly orders: readonly OrderWire[];
  /** "positionTpsl" for a request of stops on a whole position; "na" for an order on its own. */
  readonly grouping: "na" | "positionTpsl";
}

/** The prices a position's stops fire at; a kind left out is not set. */
export interface Stops {
  readonly stopLoss?: number | undefined;
  readonly takeProfit?: number | undefined;
}

/**
 * The size Hyperliquid reads as "the whole position, whatever it is when the stop fires". A stop
 * sent with it is accepted before any position exists, and follows the position as it grows.
 */
const WHOLE_POSITION = "0";

/**
 * A position's stops as Hyperliquid takes them: orders that can only close, each sized to the
 * whole position when it fires, on the side that closes a long or a short.
 */
export function stopLegs(market: Market, isLong: boolean, stops: Stops): OrderWire[] {
  const legs: OrderWire[] = [];
  for (const [tpsl, trigger] of [
    ["sl", stops.stopLoss],
    ["tp", stops.takeProfit],
  ] as const) {
    if (trigger === undefined) continue;
    const fill = isLong ? trigger * (1 - STOP_FILL_ROOM) : trigger * (1 + STOP_FILL_ROOM);
    legs.push({
      a: market.assetId,
      b: !isLong,
      p: formatPrice(fill, market.szDecimals, isLong ? "down" : "up"),
      s: WHOLE_POSITION,
      r: true,
      t: {
        trigger: {
          isMarket: true,
          triggerPx: formatPrice(trigger, market.szDecimals, "nearest"),
          tpsl,
        },
      },
    });
  }
  return legs;
}

/**
 * The tag Auni puts on an order it sends for an action, which every fill of
 * the order carries back as its `cloid`, so the statement knows it as that
 * action's (see hyperliquidStatement): the action's id, its last byte giving
 * way to the order's place among the action's orders, as Hyperliquid takes
 * each tag once. The fifteen bytes left of a random id tell actions apart.
 */
export function orderTag(actionId: string, index: number): string {
  const id = actionId.replaceAll("-", "").toLowerCase();
  return `0x${id.slice(0, 30)}${index.toString(16).padStart(2, "0")}`;
}

/**
 * Where one attempt's stops start among its action's tags, after the `kept` tags the action
 * keeps for life. An entry keeps one tag through every attempt, so a second try can never
 * place it twice. Stops are different: a try that failed took its own back off, and the next
 * try sends them again, which a tag Hyperliquid has already seen might not be let do. So each
 * attempt's two stops get tags of their own.
 */
export function stopTagsFrom(attempt: number, kept: 0 | 1): number {
  return kept + (attempt - 1) * 2;
}

/**
 * Which stop an order of an action's was, by its tag: each attempt's stops follow the `kept`
 * tags, two tags an attempt (see stopTagsFrom), the stop-loss first and the take-profit after it
 * of those `set` names (see stopLegs). Null for a tag before them, or one no stop took.
 */
export function stopOfTag(
  tag: string,
  kept: 0 | 1,
  set: { readonly stopLoss?: unknown; readonly takeProfit?: unknown },
): Exit | null {
  const index = Number.parseInt(tag.slice(32), 16) - kept;
  const legs = [
    ...(typeof set.stopLoss === "number" ? (["stop-loss"] as const) : []),
    ...(typeof set.takeProfit === "number" ? (["take-profit"] as const) : []),
  ];
  return index < 0 ? null : (legs[index % 2] ?? null);
}

/** What an order's tag keeps of its action's id (see orderTag), as lowercase hex. */
export function taggedAction(tag: string): string {
  return tag.slice(2, 32).toLowerCase();
}

/**
 * The orders, tagged as the action's, in one request; `first` is where they
 * start among the action's orders, past any it sent before.
 */
export function orderAction(
  orders: readonly OrderWire[],
  grouping: OrderAction["grouping"],
  actionId: string,
  first = 0,
): OrderAction {
  return {
    type: "order",
    orders: orders.map((order, index) => ({ ...order, c: orderTag(actionId, first + index) })),
    grouping,
  };
}

export function entryWire(input: {
  readonly market: Market;
  readonly isBuy: boolean;
  readonly price: string;
  readonly size: string;
  readonly reduceOnly: boolean;
  readonly tif: "Gtc" | "Ioc";
}): OrderWire {
  return {
    a: input.market.assetId,
    b: input.isBuy,
    p: input.price,
    s: input.size,
    r: input.reduceOnly,
    t: { limit: { tif: input.tif } },
  };
}

export function assertStopsBracket(isLong: boolean, reference: number, stops: Stops): void {
  const { stopLoss, takeProfit } = stops;
  if (stopLoss !== undefined && (isLong ? stopLoss >= reference : stopLoss <= reference)) {
    throw new Error(
      `A ${isLong ? "long" : "short"} stop-loss must sit ${isLong ? "below" : "above"} ${reference}; ${stopLoss} would trigger immediately.`,
    );
  }
  if (takeProfit !== undefined && (isLong ? takeProfit <= reference : takeProfit >= reference)) {
    throw new Error(
      `A ${isLong ? "long" : "short"} take-profit must sit ${isLong ? "above" : "below"} ${reference}; ${takeProfit} would trigger immediately.`,
    );
  }
}

/** What became of an order sent on its own: its id, and how much of it filled at once, in coins. */
interface Placed {
  readonly oid: number;
  readonly filled?: string;
}

/** Sends one order on its own, and says what became of it; one Hyperliquid refuses throws why. */
export async function placeOrder(wallets: Signer, action: OrderAction): Promise<Placed> {
  const taken = await sendL1(wallets, action);
  const [entry] = taken.response.data?.statuses ?? [];
  // Taken, with no word of whether it filled: it may have.
  if (entry === undefined || typeof entry === "string") {
    throw new MayHaveSent(
      { chain: "hyperliquid" },
      "Hyperliquid",
      "it took the order but didn't report its status",
    );
  }
  if ("error" in entry) throw refusal(entry.error);
  return "filled" in entry
    ? { oid: entry.filled.oid, filled: entry.filled.totalSz }
    : { oid: entry.resting.oid };
}

/**
 * Sends stops for a whole position. For each, in the order sent: what Hyperliquid said as it
 * refused it, or null for one it took, which answers a bare word and no order id.
 */
export async function placeStops(
  wallets: Signer,
  action: OrderAction,
): Promise<readonly (string | null)[]> {
  const statuses = (await sendL1(wallets, action)).response.data?.statuses ?? [];
  return action.orders.map((_, index) => {
    const status = statuses[index];
    return typeof status === "object" && "error" in status ? status.error : null;
  });
}

/**
 * Coins for a notional at `price`, rounded down onto the lot. An order sized
 * at or above the venue's $10 minimum rounds up instead where rounding down
 * would drop it under ($10 must not become $9.96). The venue may value the
 * order at its limit price, so the minimum is checked at the lower of the two.
 */
export function sizeFor(
  market: Market,
  notionalUsd: number,
  price: number,
  limitPrice: number = price,
): string {
  const floor = Math.min(price, limitPrice);
  let size = formatSize(notionalUsd / price, market.szDecimals);
  if (notionalUsd >= MINIMUM_ORDER_USD && Number(size) * floor < MINIMUM_ORDER_USD)
    size = formatSize(MINIMUM_ORDER_USD / floor, market.szDecimals, "up");
  if (Number(size) * floor < MINIMUM_ORDER_USD) {
    throw new Error(
      `Hyperliquid takes no order worth less than $${MINIMUM_ORDER_USD}, so $${notionalUsd} of ${market.name} is too small. Make it $${MINIMUM_ORDER_USD} or more.`,
    );
  }
  return size;
}
