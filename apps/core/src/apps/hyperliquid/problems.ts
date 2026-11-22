import { isHex } from "viem";

import type { Problems } from "../contract.ts";
import { refused, revertOf, revertWords } from "../../money/refused.ts";
import about from "./about.ts";

/**
 * What became of one order of a request the exchange took. A stop sent with an entry answers a
 * bare word: it waits for its entry to fill, or is in place and waits for its price. A cancel
 * that went answers "success".
 */
type OrderStatus =
  | { readonly resting: { readonly oid: number } }
  | { readonly filled: { readonly oid: number; readonly totalSz: string; readonly avgPx: string } }
  | { readonly error: string }
  | string;

/** A request Hyperliquid's exchange took, with what became of each order in it when it held any. */
export interface Taken {
  readonly status: "ok";
  readonly response: {
    readonly type: string;
    readonly data?: { readonly statuses?: readonly OrderStatus[] };
  };
}

/** What Hyperliquid's exchange answers: a request it took, or one it refused whole and why. */
export type ExchangeAnswer = Taken | { readonly status: "err"; readonly response: string };

/** What the exchange says of each order it refused in a request it took, in the request's order. */
export function refusedOrders(taken: Taken): string[] {
  return (taken.response.data?.statuses ?? []).flatMap((status) =>
    typeof status === "object" && "error" in status ? [status.error] : [],
  );
}

/**
 * What an answer refused, in the words of whoever gave it. From Hyperliquid's exchange: the
 * whole request, or else the first order in it. From a node on Arbitrum, where a deposit is
 * sent: what the contract reverts with, `{ data }` holding the bytes.
 */
function said(answer: unknown): string | undefined {
  const { data } = answer as { readonly data?: unknown };
  if (typeof data === "string" && isHex(data) && data.length >= 10) return revertWords(data, []);
  const given = answer as ExchangeAnswer;
  return given.status === "err" ? given.response : refusedOrders(given)[0];
}

/** What Hyperliquid answers a cancel of an order that is no longer open, whatever became of it. */
export const NOT_OPEN = "Order was never placed, already canceled, or filled.";

/**
 * Hyperliquid's refusals, as the owner should hear each. The words are Hyperliquid's own: two
 * recorded from its exchange, the rest the strings its docs list for an order, and each
 * fixture says which. The last two are what Circle's contract on Arbitrum reverts with as a
 * deposit by CCTP is sent, recorded on a fork.
 */
export const problems: Problems = {
  said,
  known: [
    {
      example: "fixtures/problems/no-account.json",
      when: /does not exist/iu,
      kind: "funds",
      say: "This wallet has no Hyperliquid account yet. Moving $1 or more of USDC into Hyperliquid opens one.",
    },
    {
      example: "fixtures/problems/nothing-to-withdraw.json",
      when: /must deposit/iu,
      kind: "funds",
      say: "There is nothing on Hyperliquid to withdraw: this wallet has never put money there.",
    },
    {
      example: "fixtures/problems/past-the-limit.json",
      when: /could not immediately match/iu,
      kind: "price",
      say: "The price moved past the worst price on your card before the order could fill, so nothing was bought or sold.",
    },
    {
      example: "fixtures/problems/not-enough-margin.json",
      when: /insufficient margin/iu,
      kind: "funds",
      say: "There isn't enough free cash in your Hyperliquid account for this, so nothing was opened.",
    },
    {
      example: "fixtures/problems/under-the-minimum.json",
      when: /minimum value of/iu,
      kind: "rule",
      say: "Hyperliquid takes no order worth less than $10, and this one came to less. Nothing was bought or sold.",
    },
    {
      example: "fixtures/problems/nothing-to-close.json",
      when: /reduce only order would increase/iu,
      kind: "rule",
      say: "There is no open position for this to close: it was closed already, or has changed sides. Nothing was bought or sold.",
    },
    {
      example: "fixtures/problems/stop-on-the-wrong-side.json",
      when: /invalid tp\/sl price/iu,
      kind: "rule",
      say: "Hyperliquid refused the stop's price. A stop-loss or take-profit has to sit past the market's price now, or it would fire the moment it was set.",
    },
    {
      example: "fixtures/problems/nobody-quoting.json",
      when: /no liquidity available/iu,
      kind: "busy",
      say: "Nobody is offering to trade this market on Hyperliquid right now, so the order found nothing to fill against.",
    },
    {
      example: "fixtures/problems/open-interest-capped.json",
      when: /open interest/iu,
      kind: "busy",
      say: "This market is at Hyperliquid's limit on open positions, so it is taking no new ones for now. Nothing was opened.",
    },
    {
      example: "fixtures/problems/far-from-the-market.json",
      when: /too far from oracle/iu,
      kind: "rule",
      say: "Hyperliquid refuses a price this far from where the market trades now. Nothing was placed.",
    },
    {
      example: "fixtures/problems/too-large-for-leverage.json",
      when: /exceed margin tier limit/iu,
      kind: "rule",
      say: "Hyperliquid allows no position this large at this leverage. Nothing was opened.",
    },
    {
      example: "fixtures/problems/order-not-open.json",
      // Said for a cancel Hyperliquid refuses, and for one Auni doesn't send (see NOT_OPEN).
      when: /never placed, already canceled, or filled/iu,
      kind: "rule",
      say: "That order is no longer open on Hyperliquid, so there was nothing to cancel.",
    },
    {
      example: "fixtures/problems/wallet-short.json",
      when: /transfer amount exceeds balance/iu,
      kind: "funds",
      say: "Your wallet holds less USDC on Arbitrum than this moves, so nothing was sent to Hyperliquid.",
    },
    {
      example: "fixtures/problems/fee-as-much-as-the-amount.json",
      when: /max fee must be less than amount/iu,
      kind: "rule",
      say: "Circle's fee for carrying this into Hyperliquid is as much as the amount itself, so nothing was sent.",
    },
  ],
};

/**
 * What to throw for a deposit's send that failed: the refusal in the owner's words when a node
 * said the transaction would revert (nothing was signed), else the error as it came, a send
 * that may have gone included (revertOf finds no revert in one).
 */
export function sendRefusal(error: unknown): unknown {
  const data = revertOf(error);
  const words = data && said({ data });
  return words ? refused(about.name, problems, words) : error;
}

/**
 * The error for what Hyperliquid said as it refused, in the owner's words where the refusal is
 * known. `then` is a sentence said after it: what the move did about the refusal, where the
 * refusal alone would leave the owner unsure what stands.
 */
export function refusal(message: string, then?: string | null): Error {
  return saidThen(refused(about.name, problems, message), then);
}

/** The error with a sentence said after its own, as `refusal` says what a move did about one. */
export function saidThen<Failure extends Error>(error: Failure, then?: string | null): Failure {
  if (then) error.message = `${error.message.replace(/[.!]?$/u, ".")} ${then}`;
  return error;
}
