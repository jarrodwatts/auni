import { type FailureKind, isAsk } from "@auni/shared";

import type { ActionRow } from "../db/schema.ts";
import { PriceMoved } from "./approved.ts";
import { leftOutPermission } from "./card-face.ts";
import { stepUpReason } from "./effect.ts";
import { FeesUnpaid, NothingMoved } from "./recipe.ts";
import { Refused } from "./refused.ts";
import { WouldFail } from "./wallet-effect.ts";
import { WITHDRAW_TOOL } from "./withdrawals.ts";

// Why a move didn't go through, so its card can offer the one next step that
// helps (see failureKindSchema). A failed step sent nothing, and execute quotes
// afresh inside the limits the person approved, so a blip, a busy venue or a
// price back inside those limits goes through when it runs again.

/**
 * What recipes and venues say, by kind, first match wins: the guess for a failure nothing
 * named. A refusal an app knows says its own kind (see Refused). Anything not here is unknown,
 * which can run again: execute refuses whatever is still wrong, with nothing sent.
 */
const SAID: readonly (readonly [FailureKind, RegExp])[] = [
  // Only words that name what the owner holds: "insufficient allowance" or "not enough liquidity"
  // is no shortage of theirs, and adding money would change nothing.
  [
    "funds",
    /insufficient[ _-]?(?:spot )?(?:funds|balance|margin|collateral|lamports)|exceeds (?:the |your )?balance|(?:not enough|too little) (?:money|funds|balance|cash|margin|collateral)|(?:too little|not enough|short of|needs?(?: about)?(?: [\d.,]+)?) \p{L}+ for (?:gas|(?:the |\p{L}+'s )?network fees?)|holds only|only has/iu,
  ],
  [
    "rule",
    /minimum|smallest size|allows at most|can only fund|not supported|not allowed|allowance|liquidity|too (?:little|small) to/iu,
  ],
  ["busy", /in.?flight|rate.?limit|too many requests|\b429\b|quota|busy|try again later/iu],
  [
    "glitch",
    /fetch failed|timed? ?out|socket hang up|network error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\b50[234]\b|in a moment/iu,
  ],
];

/** Why a run that threw stopped. */
export function failureKind(error: unknown): FailureKind {
  if (error instanceof PriceMoved) return "price";
  if (error instanceof NothingMoved) return "unfilled";
  if (error instanceof FeesUnpaid) return "fees";
  if (error instanceof Refused) return error.kind;
  if (error instanceof WouldFail) return wouldFailKind(error.message);
  const message = error instanceof Error ? error.message : String(error);
  return SAID.find(([, said]) => said.test(message))?.[0] ?? "unknown";
}

/**
 * A revert that says the trade would pay out under its least, or cost over its most: the price
 * moved. Routers say it in words or in constants ("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT").
 */
const SLIPPED =
  /return(?:ed)? amount|too little received|slippage|insufficient[ _]output|excessive[ _]input|too much requested|amount is too (?:little|low)/iu;

/**
 * Why a move a simulation showed would revert stopped, so its card offers what can help: a price
 * that moved is priced again (see quoteAgain), money short is added, and anything else is the
 * contract refusing it as it is, which the same move running again would only meet again. That
 * is a rule, never unknown, so its card offers asking Auni for another way, not Try again.
 */
function wouldFailKind(message: string): FailureKind {
  if (SLIPPED.test(message)) return "price";
  return SAID.find(([, said]) => said.test(message))?.[0] === "funds" ? "funds" : "rule";
}

/**
 * Failures the same step can't get past by running again: the money isn't
 * there, the venue won't take it, something went out, or may have, or its card never showed a
 * permission it leaves.
 */
const FINAL: ReadonlySet<FailureKind> = new Set(["funds", "rule", "sent", "unshown"]);

/** Why Try again can't run a step again, as the web reads it. */
export type RetryRefusal = "not_failed" | "not_retryable" | "needs_proof";

/**
 * Whether a failed step can run again on a tap, judged by what it recorded.
 * Money leaving the person, and anything else the owner's proof vouched
 * for, never goes again on a tap: that proof confirmed one run of one card.
 * A step stopped behind another runs again only with it (see legsToRetry).
 */
export function retryRefusal(
  row: Pick<
    ActionRow,
    | "status"
    | "failureKind"
    | "tool"
    | "details"
    | "txs"
    | "cardFormat"
    | "lines"
    | "card"
    | "proposalId"
  > &
    Partial<Pick<ActionRow, "previousErrors">>,
): RetryRefusal | null {
  if (row.status !== "failed") return "not_failed";
  // An ask that failed found Auni changed since its card: only a new card can ask again.
  if (isAsk(row.tool)) return "not_retryable";
  // A card drawn before cards said all they say now that left out a permission its run leaves
  // (see leftOutPermission): the owner's tap allowed what they saw, so only a fresh card runs it.
  if (leftOutPermission([row])) return "not_retryable";
  if (row.tool === WITHDRAW_TOOL || stepUpReason(row.details, []) !== null) return "needs_proof";
  // A step that failed before kinds were recorded may have been one that crashed after its
  // order reached the venue, and recorded nothing to show it: only a known kind runs again.
  if (row.failureKind === null || FINAL.has(row.failureKind)) return "not_retryable";
  // A price is weighed again by a fresh quote before Try again is offered (see pricedPast), but a
  // route can quote inside what was allowed and still fail its own simulation each time it is
  // built: one that already ran again on a fresh quote and failed on its price again only fails
  // the same way, so it waits for new terms from Auni.
  if (row.failureKind === "price" && row.previousErrors?.some(({ kind }) => kind === "price"))
    return "not_retryable";
  // One that sent its move, an unfilled order included, keeps sends a run again would settle by.
  if (row.txs.some((tx) => !tx.setup)) return "not_retryable";
  return null;
}
