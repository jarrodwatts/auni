import type { PickDetailWire } from "@auni/shared";

import { DAY_MS, DETAIL_TTL_MS, since, topFacts } from "../../money/detail-facts.ts";
import { usdLabel } from "../../money/format.ts";
import type { Traded } from "../../money/recipe.ts";
import { cached } from "../../money/swaps/shared.ts";
import { resolveOutcome } from "./markets.ts";
import { polymarketPrices } from "./prices.ts";

// A prediction: Polymarket's price for the outcome, read as its chance.

const chanceHistory = cached(DETAIL_TTL_MS, async (tokenId) =>
  (await polymarketPrices.history(tokenId, "1d", since())).map((point) => ({
    at: new Date(point.at).toISOString(),
    value: point.price,
  })),
);

/** The outcome's price now, from the middle of its book. */
async function chanceNow(tokenId: string): Promise<number | null> {
  const mid = await polymarketPrices.live(tokenId);
  return mid !== undefined && Number.isFinite(mid) && mid > 0 ? mid : null;
}

const RESOLVES = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export async function chanceDetail({
  market,
  outcome,
  buysUsd,
}: Extract<Traded, { kind: "outcome" }>): Promise<PickDetailWire | null> {
  const resolved = await resolveOutcome(market, outcome);
  const tokenId = resolved.tokenId.toString();
  const [history, mid] = await Promise.all([chanceHistory(tokenId), chanceNow(tokenId)]);
  const now = mid ?? history.at(-1)?.value;
  if (now === undefined || history.length < 2) return null;
  // Today's move is against the reading from about a day ago, when there is one that old.
  const dayAgo = Date.now() - DAY_MS;
  const before = history.findLast((point) => Date.parse(point.at) <= dayAgo + 4 * 3_600_000);
  const today =
    before && Date.parse(before.at) >= dayAgo - 12 * 3_600_000 ? (now - before.value) * 100 : null;
  // The chance itself is the headline, so the facts are what it pays and when it's decided.
  const facts = topFacts([
    buysUsd > 0 && now > 0 ? { label: "Pays if right", value: usdLabel(buysUsd / now) } : null,
    resolved.endDate
      ? { label: "Resolves", value: RESOLVES.format(new Date(resolved.endDate)) }
      : null,
    today === null
      ? null
      : { label: "Today", value: `${today >= 0 ? "+" : ""}${Math.round(today)} pts` },
  ]);
  return {
    kind: "chance",
    label: `${resolved.outcome} on Polymarket`,
    now,
    today,
    points: [...history, { at: new Date().toISOString(), value: now }],
    facts,
    levels: [],
  };
}
