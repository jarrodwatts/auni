import { isHex, parseAbi } from "viem";

import type { Problems } from "../contract.ts";
import { refused, revertOf, revertWords } from "../../money/refused.ts";
import about from "./about.ts";
import { VenueError } from "./http.ts";

/**
 * What bringing cash back can revert with before anything is signed: the offramp's own errors
 * (CollateralErrors.sol, verified on Polygon), and the one the library it pulls pUSD with gives
 * when the wallet holds too little. The pool's router says its own in words.
 */
const CASH_HOME_ERRORS = parseAbi(["error OnlyUnpaused()", "error TransferFromFailed()"]);

/**
 * What an answer of Polymarket's refused, in its own words: an HTTP refusal as its error says
 * it (see VenueError.said), the reason an order's own answer gives for not being placed, or
 * what a node says a contract reverts with (`{ data }`, the bytes), by the error's name.
 */
function said(answer: unknown): string | undefined {
  const { service, status, body, data } = answer as {
    readonly service?: string;
    readonly status?: number;
    readonly body?: unknown;
    readonly data?: unknown;
  };
  if (typeof data === "string" && isHex(data) && data.length >= 10)
    return revertWords(data, CASH_HOME_ERRORS);
  if (service === undefined || status === undefined) return undefined;
  if (status >= 400)
    return new VenueError(service, status, typeof body === "string" ? body : JSON.stringify(body))
      .said;
  return (body as { readonly errorMsg?: string } | null)?.errorMsg || undefined;
}

/**
 * Polymarket's refusals, as the owner should hear each: one recorded from its order book, the
 * rest the strings its docs list, and each fixture says which. Two of them answer HTTP 503: a
 * server error is otherwise no answer (see postOrder), but these are the docs' own words for
 * an exchange that accepted nothing. A refusal of its relayer that a
 * wallet has a transaction in flight is worded where it is met (relayer.ts): no answer of it
 * is recorded, and the relayer's spec gives none. The last three are what Polygon's nodes said
 * bringing cash back would revert with, run for a real deposit wallet with nothing signed.
 */
export const problems: Problems = {
  said,
  known: [
    {
      example: "fixtures/problems/region.json",
      when: /restricted in your region|\(Polymarket CLOB, HTTP 403\)$/iu,
      kind: "rule",
      say: "Polymarket doesn't take this order from where this Auni runs, and Auni keeps to that, so nothing was placed.",
    },
    {
      example: "fixtures/problems/nothing-to-match.json",
      when: /no orders found to match/iu,
      kind: "price",
      say: "Nobody on Polymarket's book was trading inside the price on your card by the time the order arrived, so nothing was bought or sold.",
    },
    {
      example: "fixtures/problems/book-behind-the-wallet.json",
      when: /not enough balance/iu,
      kind: "busy",
      say: "Polymarket's book hadn't caught up with what your Polymarket wallet holds, so it placed nothing. Cash moved in for this is in that wallet for the next try.",
    },
    {
      example: "fixtures/problems/under-the-minimum.json",
      when: /lower than the minimum|invalid amount for a marketable/iu,
      kind: "rule",
      say: "Polymarket takes no order this small on this market, so nothing was placed.",
    },
    {
      example: "fixtures/problems/restarting.json",
      when: /\(Polymarket CLOB, HTTP 425\)$/u,
      kind: "busy",
      say: "Polymarket's exchange was restarting and took no orders, so nothing was placed.",
    },
    {
      example: "fixtures/problems/trading-paused.json",
      when: /trading is currently disabled/iu,
      kind: "busy",
      say: "Polymarket has paused its exchange and is taking no orders for now, so nothing was placed.",
    },
    {
      example: "fixtures/problems/no-new-orders.json",
      when: /trading is currently cancel-only|post-only mode/iu,
      kind: "busy",
      say: "Polymarket is taking no orders like this one for now, only cancels and orders that wait on its book, so nothing was placed.",
    },
    {
      example: "fixtures/problems/too-many-requests.json",
      when: /\(Polymarket CLOB, HTTP 429\)$/u,
      kind: "busy",
      say: "Polymarket was turning requests away as too many at once, so nothing was placed.",
    },
    {
      example: "fixtures/problems/relayer-quota.json",
      when: /\(Polymarket relayer, HTTP 429\)$/u,
      kind: "busy",
      say: "Polymarket's relayer has taken as many transactions from this Auni as it allows for now, so nothing moved.",
    },
    {
      example: "fixtures/problems/pool-pays-less.json",
      when: /^Too little received$/u,
      kind: "price",
      say: "The pool that turns Polymarket's dollars into USDC now pays less than your card showed, so nothing was sent. Your cash is still in your Polymarket wallet.",
    },
    {
      example: "fixtures/problems/unwrapping-paused.json",
      when: /^OnlyUnpaused$/u,
      kind: "busy",
      say: "Polymarket has paused turning its dollars back into USDC for now, so nothing moved. Your cash is still in your Polymarket wallet.",
    },
    {
      example: "fixtures/problems/less-cash-than-asked.json",
      when: /^TransferFromFailed$/u,
      kind: "funds",
      say: "Your Polymarket wallet holds less cash than this brings back, so nothing moved.",
    },
  ],
};

/** The error for what Polymarket said as it refused, in the owner's words where the refusal is known. */
export const refusal = (message: string): Error => refused(about.name, problems, message);

/**
 * What to throw for a batch a node said would fail when it was run first, with nothing signed:
 * the refusal in the owner's words where the bytes it reverted with are known, else the error
 * as it came.
 */
export function reverted(error: unknown): unknown {
  const data = revertOf(error);
  const words = data && said({ data });
  return words ? refused(about.name, problems, words) : error;
}
