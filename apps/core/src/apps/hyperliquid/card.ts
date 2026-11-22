import { AMOUNT, type CardFace } from "@auni/shared";

import { figures } from "../../money/card-face.ts";
import { usdLabel } from "../../money/format.ts";
import about from "./about.ts";
import { tickerOf } from "./keys.ts";

// What each Hyperliquid card says (see CardFace in @auni/shared). A card names a market by its
// ticker, as the portfolio does, and says what a perp's owner most needs before a tap: how far
// the price can go before the position is gone, the worst price a close fills at, what a
// withdrawal lands after the fee, what cancelling an order leaves behind. None types the card's
// own amount: it says AMOUNT.

type Side = "long" | "short";

/** "stop-loss and take-profit", from the kinds given. */
function listed(names: readonly string[]): string {
  return names.join(" and ");
}

/** A stop's price as a figure says it, with the price it moves from when the position has one already. */
function movedFrom(price: string, was: string | null): string {
  return was && was !== price ? `${price}, was ${was}` : price;
}

/** An order as its card says it: the market, which way, and how large. */
interface OrderWords {
  readonly market: string;
  readonly side: Side;
  readonly leverage: number;
  /** The position's notional: "$100.00". */
  readonly size: string;
  /** The price a limit order waits for: "$90,000". Null for one that fills at the market now. */
  readonly limit: string | null;
  /** How far the price can go against it before it is liquidated, as a share of its entry. */
  readonly liquidationMove: number;
  /** The position's stops once the order is sent: "$85,000". Null for one it doesn't set. */
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** The stop of each kind in place now, which the order's own replaces. Null with none. */
  readonly stopLossWas: string | null;
  readonly takeProfitWas: string | null;
  /** Stops an order that ended left on Hyperliquid, which this one takes off: "stop-loss at $85,000". */
  readonly comeOff: readonly string[];
  /** Whether a position is open already, which the order adds to and its stops cover from now. */
  readonly adds: boolean;
}

/**
 * What an order's card says: the margin is the card's amount, the position is what it opens,
 * and its stops are the position's, held by Hyperliquid from the moment the order is sent.
 */
export function orderFace(order: OrderWords): CardFace {
  const { side, size, limit, stopLoss, takeProfit, comeOff } = order;
  const coin = tickerOf(order.market);
  const direction = side === "short" ? "Short" : "Long";
  const leverage = `${order.leverage}x`;
  const stops = listed(
    [stopLoss ? "stop-loss" : "", takeProfit ? "take-profit" : ""].filter(Boolean),
  );
  const both = !!stopLoss && !!takeProfit;
  const wipedOut = `${Math.round(order.liquidationMove * 100)}%`;
  // Once the move is done its stops are on Hyperliquid, so its receipt says them too.
  const placed = [
    stopLoss ? `a stop-loss at ${stopLoss}` : "",
    takeProfit ? `a take-profit at ${takeProfit}` : "",
  ].filter(Boolean);
  const withStops = placed.length ? `, with ${listed(placed)}` : "";
  const finePrint = [
    limit
      ? `It waits on ${about.name}'s book and opens only if ${coin} trades at ${limit} or better.`
      : null,
    `${about.name} closes it by itself, and what you put in is gone, if ${coin} ${side === "long" ? "falls" : "rises"} about ${wipedOut} from where it opens.`,
    // The stops are the position's, on Hyperliquid before anything fills: they cover what is
    // held already from the moment the order is sent, and whatever of the order fills.
    !stops
      ? null
      : order.adds
        ? `Its ${stops} ${both ? "rest" : "rests"} on ${about.name} from now, on the position you already hold and whatever this adds.`
        : limit
          ? `Its ${stops} ${both ? "rest" : "rests"} on ${about.name} from now and ${both ? "close" : "closes"} whatever has filled.`
          : `Its ${stops} ${both ? "rest" : "rests"} on ${about.name} and ${both ? "close" : "closes"} the whole position at the market.`,
    // One reached while nothing is held is used up, which a take-profit can be before a fill.
    limit && takeProfit && !order.adds
      ? `If ${coin} reaches ${takeProfit} before any of it fills, the take-profit is used up, and Auni tells you when it fills.`
      : null,
    comeOff.length
      ? `An earlier order's ${listed(comeOff)} ${comeOff.length > 1 ? "come" : "comes"} off.`
      : null,
  ].filter(Boolean);
  return {
    title: `${direction} ${coin} at ${leverage}`,
    action: `${direction} ${coin}`,
    working: limit ? "Placing your order" : `Opening your ${side}`,
    context: about.name,
    figures: figures(
      { label: "You put in", value: AMOUNT },
      { label: "Position", value: size },
      { label: "Leverage", value: leverage },
      limit ? { label: "Opens at", value: `${limit} or better` } : null,
      stopLoss ? { label: "Stop-loss", value: movedFrom(stopLoss, order.stopLossWas) } : null,
      takeProfit
        ? { label: "Take-profit", value: movedFrom(takeProfit, order.takeProfitWas) }
        : null,
    ),
    finePrint: finePrint.join(" "),
    receipt: limit
      ? {
          // An order that rests has opened nothing yet, so its receipt says only that it is placed.
          title: `Placed an order to go ${side} ${coin}`,
          detail: `${size} at ${leverage} on ${about.name}, once ${coin} trades at ${limit} or better${withStops}`,
          amount: null,
        }
      : {
          title: `Opened a ${side} on ${coin}`,
          detail: `${size} at ${leverage} on ${about.name}${withStops}`,
          amount: "spent",
        },
  };
}

/** A close as its card says it. */
interface CloseWords {
  readonly market: string;
  readonly side: Side;
  /** How much of the position it closes, of 100. */
  readonly percent: number;
  /** The coins it closes: "0.01627". */
  readonly size: string;
  /** The worst price it closes at: "$97,416". */
  readonly worst: string;
  /** What the part it closes has made so far, below zero for a loss. */
  readonly pnlUsd: number;
  /** Whether an order still waits to open more of it, which the position's stops stay on for. */
  readonly orderWaits: boolean;
}

/** What a close's card says: what it closes, what that has made, and the worst price it goes at. */
export function closeFace(close: CloseWords): CardFace {
  const { side, percent } = close;
  const coin = tickerOf(close.market);
  const all = percent === 100;
  const closed = `${all ? "" : `${percent}% of `}your ${coin} ${side}`;
  const made = Math.round(close.pnlUsd * 100) / 100;
  return {
    title: `Close ${closed}`,
    // What the position is worth comes back, which the card's amount says; the title is whole.
    note: "coming back",
    action: all ? `Close ${side}` : `Close ${percent}%`,
    working: `Closing ${closed}`,
    context: about.name,
    figures: figures(
      { label: "Closes", value: `${close.size} ${coin}` },
      made === 0
        ? null
        : { label: made > 0 ? "Gain so far" : "Loss so far", value: usdLabel(Math.abs(made)) },
      {
        label: side === "long" ? "Sells at no less than" : "Buys back at no more than",
        value: close.worst,
      },
    ),
    finePrint: `It closes at the market on ${about.name}, or not at all if the price is past that by then.${
      !all
        ? ""
        : close.orderWaits
          ? " Any stop-loss or take-profit on it stays, for the order still waiting to open more."
          : " Any stop-loss or take-profit on it is cancelled with it."
    }`,
    receipt: {
      title: `Closed ${closed}`,
      detail: `${close.size} ${coin} at the market on ${about.name}`,
      amount: "back",
    },
  };
}

/** A change of stops as its card says it: each stop's new price, null to remove it, undefined to leave it. */
interface StopsWords {
  readonly market: string;
  readonly side: Side;
  readonly stopLoss: string | null | undefined;
  readonly takeProfit: string | null | undefined;
  /** The stop of each kind in place now, which a new one replaces. Null with none. */
  readonly stopLossWas: string | null;
  readonly takeProfitWas: string | null;
  /** The market's price now: "$3,431.20". */
  readonly now: string;
}

/** What a change of stops says: which exit it sets or removes, at what price, and the price now. */
export function stopsFace(stops: StopsWords): CardFace {
  const coin = tickerOf(stops.market);
  const each = [
    { name: "stop-loss", price: stops.stopLoss, was: stops.stopLossWas },
    { name: "take-profit", price: stops.takeProfit, was: stops.takeProfitWas },
  ].filter(({ price }) => price !== undefined);
  const sets = each.filter(({ price }) => price !== null).map(({ name }) => name);
  const removes = each.filter(({ price }) => price === null).map(({ name }) => name);
  const capital = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  const position = `your ${coin} ${stops.side}`;
  const [verb, done, doing, what] =
    removes.length === 0
      ? ["Set", "Set", "Setting", `a ${sets.join(" and ")} on ${position}`]
      : sets.length === 0
        ? ["Remove", "Removed", "Removing", `the ${removes.join(" and ")} from ${position}`]
        : ["Change", "Changed", "Changing", `the stops on ${position}`];
  return {
    title: `${verb} ${what}`,
    action: `${verb} ${each.length === 1 ? each[0]!.name : "stops"}`,
    working: `${doing} ${what}`,
    context: about.name,
    figures: figures(
      ...each.map(({ name, price, was }) => ({
        label: capital(name),
        value: price ? movedFrom(price, was) : "Removed",
      })),
      { label: "Price now", value: stops.now },
    ),
    finePrint: sets.length
      ? `${about.name} closes the whole position at the market once its price reaches ${sets.length === 1 ? "it" : "either"}, however much the position has grown by then. Nothing moves until then.`
      : "Nothing moves now. The position stays open without it.",
    receipt: {
      title: `${done} ${what}`,
      detail: capital(
        each
          .map(({ name, price }) => (price === null ? `${name} removed` : `${name} at ${price}`))
          .join(", "),
      ),
      amount: null,
    },
  };
}

/** A cancel of an order still waiting, as its card says it. */
interface CancelWords {
  readonly market: string;
  /** What the order would do, in the owner's words: "go long", "sell". */
  readonly does: string;
  /** The coins of it that still wait: "0.00652 BTC". */
  readonly waiting: string;
  /** The price it waits for: "$92,000". */
  readonly price: string;
  /** What of it has filled already: "0.002 BTC". Null when none has. */
  readonly filled: string | null;
  /** The position's stops on this market, each as "stop-loss at $85,000". */
  readonly stops: readonly string[];
  /**
   * What becomes of those stops: they come off with the order when nothing would be left for
   * them to close, and stay for the position that is open, or for another order still waiting.
   */
  readonly stopsStayFor: "position" | "order" | null;
  /** Stops attached to the order in Hyperliquid's own app, which Hyperliquid cancels with it. */
  readonly attached: readonly string[];
}

/**
 * What a cancel's card says: which order comes off the book, that nothing is bought or sold,
 * and what becomes of the position's stops.
 */
export function cancelFace(cancel: CancelWords): CardFace {
  const { does, filled, stops, attached } = cancel;
  const coin = tickerOf(cancel.market);
  const order = `your order to ${does} ${coin}`;
  const all = [...stops, ...attached];
  const protection = !stops.length
    ? null
    : cancel.stopsStayFor === "position"
      ? `${filled ? "What has filled" : `Your ${coin} position`} keeps its ${listed(stops)}.`
      : cancel.stopsStayFor === "order"
        ? `The ${listed(stops)} ${stops.length > 1 ? "stay" : "stays"}, for the other order still waiting on ${coin}.`
        : `Its ${listed(stops)} ${stops.length > 1 ? "come" : "comes"} off with it.`;
  // An order placed in Hyperliquid's own app can carry stops of its own, which go with it.
  const goes = attached.length
    ? `Its ${listed(attached)} ${attached.length > 1 ? "are" : "is"} cancelled with it${filled && !stops.length ? `, so what has filled has no ${all.length > 1 ? "stops" : "stop"}` : ""}.`
    : null;
  return {
    title: `Cancel ${order}`,
    action: "Cancel order",
    working: `Cancelling ${order}`,
    context: about.name,
    figures: figures(
      { label: "Still waiting", value: cancel.waiting },
      { label: "Waiting for", value: `${cancel.price} or better` },
      { label: "Filled so far", value: filled ?? "Nothing" },
    ),
    finePrint: [
      filled
        ? `Nothing more is bought or sold: the rest of the order comes off ${about.name}'s book, and what has filled stays open as your position.`
        : `Nothing is bought or sold: the order comes off ${about.name}'s book.`,
      protection,
      goes,
    ]
      .filter(Boolean)
      .join(" "),
    receipt: {
      title: `Cancelled ${order}`,
      detail: filled
        ? `${filled} had filled and stays open. Nothing more was bought or sold.`
        : "Nothing was bought or sold.",
      amount: null,
    },
  };
}

/**
 * What the card that takes off a leftover stop says: a stop an order left on Hyperliquid when
 * it ended somewhere Auni didn't see, with nothing now for it to close.
 */
export function leftoverFace(stop: {
  readonly market: string;
  /** "stop-loss" or "take-profit". */
  readonly kind: string;
  /** The price it would fire at: "$85,000". */
  readonly price: string;
}): CardFace {
  const coin = tickerOf(stop.market);
  const what = `the leftover ${stop.kind} on ${coin}`;
  return {
    title: `Remove ${what}`,
    action: `Remove ${stop.kind}`,
    working: `Removing ${what}`,
    context: about.name,
    figures: figures(
      { label: "Would fire at", value: stop.price },
      { label: "Protects", value: "Nothing now" },
    ),
    finePrint: `An order that has ended left it on ${about.name}. Nothing is bought or sold. Left there, it would close the next ${coin} position you open when ${coin} reaches that price.`,
    receipt: {
      title: `Removed ${what}`,
      detail: "Nothing was bought or sold.",
      amount: null,
    },
  };
}

/** A deposit as its card says it. */
interface DepositWords {
  /** Where it leaves from: "Arbitrum". */
  readonly from: string;
  /** What lands in the account: "$9.80". */
  readonly arrives: string;
  /** What Circle keeps of it on the way: "$0.20". */
  readonly fee: string;
}

/** What a deposit's card says: cash leaving the wallet for the account positions draw on. */
export function depositFace({ from, arrives, fee }: DepositWords): CardFace {
  return {
    title: `Move cash into ${about.name}`,
    note: "to move",
    action: `Move ${AMOUNT}`,
    working: `Moving it into ${about.name}`,
    context: `From your wallet on ${from}`,
    figures: figures(
      // What leaves is the card's amount; Circle's fee makes what arrives less, so both are said.
      { label: "You get", value: arrives },
      { label: "Circle keeps", value: fee },
      { label: "Arrives", value: "In about a minute" },
    ),
    finePrint: `It lands as free cash in your ${about.name} account, which positions there take their margin from.`,
    receipt: {
      title: `Moved cash into ${about.name}`,
      detail: `${arrives} from your wallet on ${from}, after Circle's ${fee} fee`,
      amount: "spent",
    },
  };
}

/** A withdrawal as its card says it. */
interface WithdrawWords {
  /** Where it lands: "Arbitrum". */
  readonly to: string;
  /** What lands there once the fee is kept: "$499". */
  readonly arrives: string;
  /** What Hyperliquid keeps: "$1". */
  readonly fee: string;
  /** Whether it takes all the cash free now. */
  readonly all: boolean;
}

/** What a withdrawal's card says: what leaves the account, what the fee keeps, and what lands. */
export function withdrawFace(withdraw: WithdrawWords): CardFace {
  const { to, arrives, fee } = withdraw;
  return {
    title: `Bring cash back from ${about.name}`,
    note: "to withdraw",
    action: `Withdraw ${AMOUNT}`,
    working: `Withdrawing from ${about.name}`,
    // What leaves is the card's amount; the line under it says why less lands.
    context: `To ${to}, after a ${fee} fee`,
    figures: figures(
      { label: "You get", value: arrives },
      { label: `${about.name} keeps`, value: fee },
      { label: "Arrives", value: "In a few minutes" },
    ),
    finePrint: `${withdraw.all ? "That is all the cash free there now. " : ""}What your open positions hold as margin stays with them.`,
    receipt: {
      title: `Withdrew from ${about.name}`,
      detail: `${arrives} to your wallet on ${to}, after ${about.name}'s ${fee} fee`,
      amount: null,
    },
  };
}
