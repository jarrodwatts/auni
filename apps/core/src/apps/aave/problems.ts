import { isHex, parseAbi } from "viem";

import type { Problems } from "../contract.ts";
import { refused, revertOf, revertWords } from "../../money/refused.ts";
import about from "./about.ts";

/**
 * The errors Aave V3's pool reverts with that a supply or a withdrawal can meet (Errors.sol in
 * aave-dao/aave-v3-origin). Every market Auni uses answers with these, not V3's older numbered
 * strings (each pool was asked, fixtures/problems/).
 */
const POOL_ERRORS = parseAbi([
  "error InvalidAmount()",
  "error ReserveInactive()",
  "error ReserveFrozen()",
  "error ReservePaused()",
  "error NotEnoughAvailableUserBalance()",
  "error SupplyCapExceeded()",
]);

/**
 * What a node said Aave's pool reverts with, by its name: an error of the pool's, a token's own
 * words ("ERC20: transfer amount exceeds balance"), or a panic by its code. `answer` is the
 * node's answer to the call, `{ data }` holding the bytes it reverted with.
 */
function said(answer: unknown): string | undefined {
  const { data } = answer as { readonly data?: unknown };
  if (typeof data !== "string" || !isHex(data) || data.length < 10) return undefined;
  return revertWords(data, POOL_ERRORS);
}

/**
 * Aave's refusals, as the owner should hear each. Two are recorded from Aave's live pools with a
 * key that never held money, the rest from Base's pool on a fork, where a reserve can be filled,
 * frozen, paused or lent out; each fixture says how.
 */
export const problems: Problems = {
  said,
  known: [
    {
      example: "fixtures/problems/supply-cap.json",
      when: /^SupplyCapExceeded$/u,
      kind: "rule",
      say: "Aave's USDC savings on this chain are full: the market has taken in all it allows, so nothing was put in. Your USDC is still in your wallet.",
    },
    {
      example: "fixtures/problems/frozen.json",
      when: /^ReserveFrozen$/u,
      kind: "rule",
      say: "Aave has frozen its USDC market on this chain, so it takes no new savings and nothing was put in. Savings already there can still come out.",
    },
    {
      example: "fixtures/problems/paused.json",
      when: /^(ReservePaused|ReserveInactive)$/u,
      kind: "rule",
      say: "Aave has paused its USDC market on this chain, so nothing moved. Savings there are still yours, and can come out once Aave lifts the pause.",
    },
    {
      example: "fixtures/problems/lent-out.json",
      when: /^panic 0x11$/u,
      kind: "busy",
      say: "Aave's USDC pool on this chain has lent out too much of its cash to pay this back now, so nothing was taken out. Your savings stay there, earning.",
    },
    {
      example: "fixtures/problems/not-that-much-saved.json",
      when: /^NotEnoughAvailableUserBalance$/u,
      kind: "funds",
      say: "There is less in Aave savings on this chain than this asks for, so nothing was taken out.",
    },
    {
      example: "fixtures/problems/wallet-short.json",
      when: /transfer amount exceeds balance/u,
      kind: "funds",
      say: "Your wallet holds less USDC on this chain than this puts in, so nothing went into savings.",
    },
    {
      example: "fixtures/problems/nothing-to-move.json",
      when: /^InvalidAmount$/u,
      kind: "rule",
      say: "That amount is too small for Aave to move, so nothing moved.",
    },
  ],
};

/**
 * What to throw for a send that failed: Aave's refusal in the owner's words when a node said the
 * pool would revert (nothing was signed), else the error as it came, a send that may have gone
 * included (revertOf finds no revert in one).
 */
export function refusal(error: unknown): unknown {
  const data = revertOf(error);
  const words = data && said({ data });
  return words ? refused(about.name, problems, words) : error;
}
