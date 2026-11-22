import { AMOUNT, type CardFace } from "@auni/shared";

import { figures } from "../../money/card-face.ts";
import about from "./about.ts";

/** An order as its card says it: the market's question, the outcome, and what a share costs. */
interface OrderWords {
  readonly side: "buy" | "sell";
  readonly question: string;
  readonly outcome: string;
  /** Dollars per share, between 0 and 1: the limit, or the best on the book now. Null when nobody is offering. */
  readonly price: number | null;
  /** About how many shares the money buys: "8.06". Null when it can't be priced. */
  readonly shares: string | null;
  /** The worst price it fills at, in dollars a share, which the order is held to. */
  readonly worst: number;
}

/**
 * What becomes of the cash Polymarket pays back, said on every order's card, so the owner knows
 * before money goes in and when it comes out: it waits there until they ask for it.
 */
export const CASH_WAITS = `Cash from a sale or a payout waits in your ${about.name} wallet and pays for your next buy there. Ask Auni to bring it back to your own wallet whenever you like.`;

/** A share's price as a card says it: "62¢", "61.5¢". */
export const cents = (price: number) => `${Number((price * 100).toFixed(1))}¢`;

/** What a row for a bet says before its market's name, in place of buying. */
const BET = { now: "Betting on", done: "Bet on", failed: "Didn't bet on" } as const;

/** What an order's card says. On a plan it reads as its market, with the outcome as a tag. */
export function orderFace(order: OrderWords): CardFace {
  const { question, outcome } = order;
  // Said as its bound is, to the tenth of a cent a share can be priced at, so the two agree.
  const price = order.price === null ? null : cents(order.price);
  if (order.side === "sell") {
    return {
      title: `Sell ${outcome}`,
      // What the shares fetch comes back, which the card's amount says; the title is whole.
      note: "coming back",
      action: `Sell ${outcome}`,
      working: `Selling ${outcome}`,
      context: question,
      figures: figures(
        order.shares ? { label: "Shares", value: order.shares } : null,
        price ? { label: "Price", value: price } : null,
        { label: "Price, at least", value: cents(order.worst) },
      ),
      finePrint: `It sells at the best price on ${about.name}'s book. ${CASH_WAITS}`,
      price,
      pick: { name: question, tag: outcome },
      receipt: { title: `Sold ${outcome}`, detail: question, amount: "back" },
    };
  }
  return {
    title: `Buy ${outcome} for ${AMOUNT}`,
    action: `Buy ${AMOUNT}`,
    working: `Buying ${outcome}`,
    context: question,
    figures: figures(
      { label: "You pay", value: AMOUNT },
      order.shares ? { label: "You get, about", value: `${order.shares} shares` } : null,
      price ? { label: "Price", value: price } : null,
      { label: "Price, at most", value: cents(order.worst) },
    ),
    // The buy lets Polymarket redeem the shares for the owner, so the card says so.
    finePrint: `Each share pays $1 if the answer is ${outcome}, and ${about.name} collects it for you when the market resolves. ${CASH_WAITS}`,
    price,
    pick: { name: question, tag: outcome, verbs: BET },
    receipt: { title: `Bought ${outcome}`, detail: question, amount: "spent" },
  };
}

/** A withdrawal as its card says it: what the pool pays now, and the least the card accepts. */
interface WithdrawWords {
  /** Dollars of USDC the pool pays for it now: "$19.99". */
  readonly arrives: string;
  /** The fewest dollars of USDC it lets arrive: "$19.97". */
  readonly least: string;
  /** Whether it brings all the cash there. */
  readonly all: boolean;
}

/** What a withdrawal's card says: cash leaving the Polymarket wallet, and USDC arriving in the owner's own. */
export function withdrawFace({ arrives, least, all }: WithdrawWords): CardFace {
  return {
    title: `Bring cash back from ${about.name}`,
    note: "to bring back",
    action: `Bring back ${AMOUNT}`,
    working: `Bringing it back from ${about.name}`,
    context: "To your own wallet on Polygon",
    figures: figures(
      { label: `Leaves ${about.name}`, value: AMOUNT },
      { label: "You get, about", value: `${arrives} of USDC` },
      { label: "You get, at least", value: `${least} of USDC` },
    ),
    finePrint: `${all ? "That is all the cash there now. " : ""}${about.name}'s dollars become USDC through a pool, so about what leaves arrives, and never less than the least shown here. Your bets stay where they are.`,
    receipt: {
      title: `Brought cash back from ${about.name}`,
      detail: "To your own wallet on Polygon, as USDC",
      amount: "spent",
    },
  };
}
