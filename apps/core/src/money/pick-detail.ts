import type { NetworkKey, PickDetailWire } from "@auni/shared";

import { accountOf } from "../apps/registry.ts";
import { chainName } from "./chains.ts";
import {
  DETAIL_TTL_MS,
  quarterFact,
  since,
  todayFact,
  topFacts,
} from "./detail-facts.ts";
import { formatAmount } from "./format.ts";
import { subjectOf, type PickedAction, type Traded } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";
import { cached } from "./swaps/shared.ts";
import { feedDay, feedHistory } from "./token-feeds.ts";

/**
 * What a pick on a proposal card shows when someone opens it: its line over
 * about three months and the few numbers that matter for its kind, read live
 * from the source that prices it. Nothing here is stored.
 */

/**
 * A pick's detail; null for a move with nothing to chart. A token's is read here; anything else
 * a move trades, its app's account reads (see Account.detail).
 */
export function pickDetail(action: PickedAction): Promise<PickDetailWire | null> {
  const recipe = recipeForTool(action.tool);
  const subject = recipe ? subjectOf(recipe, action) : null;
  switch (subject?.kind) {
    case "token":
      return priceDetail(subject);
    case "perp":
    case "outcome":
      return accountOf(recipe!.venue)?.account.detail?.(subject, action) ?? Promise.resolve(null);
    default:
      // Cash and apps have no price to chart.
      return Promise.resolve(null);
  }
}

// A stock or token: the public feeds price it by chain and address.

const dailyHistory = cached(DETAIL_TTL_MS, async (id) =>
  (await feedHistory(id, "1d", since())).map((point) => ({
    at: new Date(point.at).toISOString(),
    value: point.price,
  })),
);

async function priceDetail(
  token: Extract<Traded, { kind: "token" }>,
): Promise<PickDetailWire | null> {
  const id = `${token.chain}:${token.mint}`;
  const [history, latest] = await Promise.all([dailyHistory(id), feedDay(id)]);
  const now = latest.price ?? history.at(-1)?.value;
  if (now === undefined || history.length < 2) return null;
  const today = latest.today ?? null;
  const own =
    token.symbol && token.buysUsd > 0
      ? {
          label: "You'd own",
          value: `${formatAmount(token.buysUsd / now)} ${token.stock ? "shares" : token.symbol}`,
        }
      : null;
  return {
    kind: "price",
    label: token.stock ? "Stock, trades 24/7" : `Token on ${chainName(token.chain as NetworkKey)}`,
    now,
    today,
    points: [...history, { at: new Date().toISOString(), value: now }],
    // A sell owns nothing more, so its second fact is the longer move.
    facts: topFacts([todayFact(today), own, quarterFact(history, now)]),
    levels: [],
  };
}
