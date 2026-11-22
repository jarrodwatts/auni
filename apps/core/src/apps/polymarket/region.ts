import { z } from "zod";

import type { NoNewPositions } from "../contract.ts";

// Polymarket decides who may trade by the internet address an order comes from, so from some
// places it takes no new bets and from a few no orders at all. It says which for the machine
// asking at GET polymarket.com/api/geoblock (docs.polymarket.com/developers/CLOB/geoblock, read
// 2026-11-14): `blocked` is whether that machine may place new orders. Auni asks before it
// offers a bet, so no money moves toward an order Polymarket would refuse.

const GEOBLOCK = "https://polymarket.com/api/geoblock";

const answerSchema = z.object({ blocked: z.boolean(), country: z.string() });
type Answer = z.infer<typeof answerSchema>;

/**
 * Where Polymarket's docs say it takes no orders at all, sales included: the countries under
 * sanctions. Everywhere else it blocks is close-only, where a bet held can still be sold.
 */
const NO_ORDERS = new Set(["CU", "IR", "KP", "SY"]);

/**
 * Where its docs say only its website is close-only and its API, which Auni trades through, is
 * not restricted (Malta's website only for sports): the check answers blocked there all the same.
 */
const API_OPEN = new Set(["IE", "JP", "KR", "MT", "NL"]);

/** How long an answer is kept: an address changes rarely, and a bet card is never slowed by it. */
const KEPT_MS = 10 * 60_000;
/** How long Auni waits before it asks again after Polymarket couldn't be asked. */
const UNREAD_MS = 60_000;
const TIMEOUT_MS = 3_000;

let kept: { readonly until: number; readonly answer: Promise<Answer | null> } | undefined;

/** Polymarket's answer for this machine, kept a while; null when it couldn't be read. */
function geoblock(): Promise<Answer | null> {
  const now = Date.now();
  if (kept && kept.until > now) return kept.answer;
  const answer = fetch(GEOBLOCK, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then(async (response) => answerSchema.parse(await response.json()))
    .catch((error: unknown) => {
      console.warn("Polymarket's region check couldn't be read:", String(error));
      kept = { until: Date.now() + UNREAD_MS, answer: Promise.resolve(null) };
      return null;
    });
  kept = { until: now + KEPT_MS, answer };
  return answer;
}

/** A country's name by its code, "Australia" for "AU"; the code itself where none is known. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * What Polymarket's answer means for the owner: null while it takes new bets from here, or
 * when it couldn't be asked, so a check that fails changes nothing. Its words say what still
 * works, and never a way round the rule: Auni keeps to it.
 */
export function regionRule(answer: Answer | null): NoNewPositions | null {
  if (!answer?.blocked || API_OPEN.has(answer.country)) return null;
  const where = countryName(answer.country);
  if (NO_ORDERS.has(answer.country))
    return {
      short: "No trading from here",
      says: `Polymarket takes no orders where this Auni runs (${where}), so no bet can be placed or sold here, and Auni keeps to that.`,
    };
  return {
    short: "No new bets from here",
    says: `Polymarket takes no new bets where this Auni runs (${where}), and Auni keeps to that. Selling a bet you hold there, and bringing your Polymarket cash home, still work.`,
  };
}

/** Whether Polymarket takes new bets from this machine now (see App.noNewPositions). */
export async function polymarketRegion(): Promise<NoNewPositions | null> {
  return regionRule(await geoblock());
}

/** Forgets the kept answer, so a test asks again. */
export function forgetRegion(): void {
  kept = undefined;
}
