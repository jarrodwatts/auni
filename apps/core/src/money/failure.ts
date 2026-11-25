import { type FailureKind, isAsk } from "@auni/shared";

import type { ActionRow } from "../db/schema.ts";
import { PriceMoved } from "./approved.ts";
import { leftOutPermission } from "./card-face.ts";
import { stepUpReason } from "./effect.ts";
import { FeesUnpaid, NothingMoved } from "./recipe.ts";
import { Refused } from "./refused.ts";
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
  ["funds", /insufficient|not enough|too little|holds only|only has|exceeds (the )?balance/iu],
  ["rule", /minimum|smallest size|allows at most|can only fund|not supported|not allowed/iu],
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
  const message = error instanceof Error ? error.message : String(error);
  return SAID.find(([, said]) => said.test(message))?.[0] ?? "unknown";
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
  >,
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
  // One that sent its move, an unfilled order included, keeps sends a run again would settle by.
  if (row.txs.some((tx) => !tx.setup)) return "not_retryable";
  return null;
}
