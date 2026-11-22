import { isHex, parseAbi } from "viem";

import type { Problems } from "../contract.ts";
import { refused, revertOf, revertWords } from "../../money/refused.ts";
import about from "./about.ts";

/**
 * The errors a deposit can revert with as it leaves: Across's SpokePool's and, for a token
 * swapped as it leaves, its SpokePoolPeriphery's (github.com/across-protocol/contracts).
 */
const DEPOSIT_ERRORS = parseAbi([
  "error DepositsArePaused()",
  "error InvalidQuoteTimestamp()",
  "error InvalidFillDeadline()",
  "error ExpiredFillDeadline()",
  "error MinimumExpectedInputAmount()",
  "error SwapFailed()",
]);

/**
 * What an answer of Across's refused, in its own words. Two kinds of answer reach it: its API's
 * refusal, `{ status, body }`, read as the code and message its body gives; and a node's answer
 * to a simulated deposit (`error.data`, or `data` as revertOf finds it), read as the name of the
 * error the deposit reverted with.
 */
function said(answer: unknown): string | undefined {
  const given = answer as {
    readonly status?: number;
    readonly body?: unknown;
    readonly data?: unknown;
    readonly error?: { readonly data?: unknown };
  };
  const bytes = given.error?.data ?? given.data;
  if (typeof bytes === "string" && isHex(bytes) && bytes.length >= 10) {
    return revertWords(bytes, DEPOSIT_ERRORS);
  }
  if (given.status === undefined || given.status < 400) return undefined;
  const body = given.body as { readonly code?: string; readonly message?: string } | string | null;
  const words =
    typeof body === "string" ? body : [body?.code, body?.message].filter(Boolean).join(": ");
  return `${words || "no reason given"} (HTTP ${given.status})`;
}

const CANT_CARRY =
  "Across hasn't enough money on that route right now to carry this much, so nothing was sent. A smaller amount can go now.";

/**
 * Across's refusals, as the owner should hear each. Three are recorded from its API with a
 * wallet that never held money and one from its SpokePool on a fork; the rest are from its docs
 * and its contracts' source, and each fixture says which.
 */
export const problems: Problems = {
  said,
  known: [
    {
      example: "fixtures/problems/amount-too-low.json",
      when: /AMOUNT_TOO_LOW|too low to cover/u,
      kind: "rule",
      say: "That's too little to move with Across now: its fees would take all of it, so nothing was sent.",
    },
    {
      example: "fixtures/problems/amount-too-high.json",
      when: /AMOUNT_TOO_HIGH|higher than available liquidity/u,
      kind: "rule",
      say: CANT_CARRY,
    },
    {
      example: "fixtures/problems/relayer-short.json",
      when: /enough funds to support this deposit/u,
      kind: "rule",
      say: CANT_CARRY,
    },
    {
      example: "fixtures/problems/too-many-requests.json",
      when: /\(HTTP 429\)$/u,
      kind: "busy",
      say: "Across was turning requests away as too many at once, so nothing was sent.",
    },
    {
      example: "fixtures/problems/stale-quote.json",
      when: /^(InvalidQuoteTimestamp|InvalidFillDeadline|ExpiredFillDeadline)$/u,
      kind: "busy",
      say: "Across's quote went stale before it could be sent, so nothing was sent. Trying again quotes it afresh.",
    },
    {
      example: "fixtures/problems/swap-moved.json",
      when: /^(MinimumExpectedInputAmount|SwapFailed)$/u,
      kind: "price",
      say: "The price of what you're selling moved past the least your card allowed before Across could swap it, so nothing was sent.",
    },
    {
      example: "fixtures/problems/deposits-paused.json",
      when: /^DepositsArePaused$/u,
      kind: "busy",
      say: "Across has paused deposits for now, so nothing was sent. Your money is still where it was.",
    },
  ],
};

/** The error for Across's API refusing a request, in the owner's words where the refusal is known. */
export const apiRefusal = (status: number, body: unknown): Error =>
  refused(about.name, problems, said({ status, body })!);

/**
 * What to throw for a deposit whose simulation failed: Across's refusal in the owner's words when
 * the deposit reverted with an error it knows, else the error as it came, which says which call
 * reverted and why as core's simulation read it.
 */
export function depositRefusal(error: unknown): unknown {
  const data = revertOf(error);
  const words = data && said({ data });
  const known = words !== undefined && problems.known.some(({ when }) => when.test(words));
  return known ? refused(about.name, problems, words) : error;
}
