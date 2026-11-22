import type { Instrument } from "../contract.ts";
import { searchEvents, type GammaMarket } from "./markets.ts";

function eventOutcomes(live: readonly GammaMarket[]): NonNullable<Instrument["outcomes"]> {
  const parse = (value: string | undefined): string[] =>
    value ? (JSON.parse(value) as string[]) : [];
  if (live.length === 1 && live[0]) {
    const [market] = live;
    const prices = parse(market.outcomePrices);
    const tokens = parse(market.clobTokenIds);
    return parse(market.outcomes).map((name, index) => ({
      name,
      price: Number(prices[index] ?? 0),
      tokenId: tokens[index] ?? "",
    }));
  }
  // Multi-market events list each market's Yes side, busiest first.
  return [...live]
    .sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0))
    .slice(0, 6)
    .map((market) => ({
      name: market.groupItemTitle || market.question,
      price: Number(parse(market.outcomePrices)[0] ?? 0),
      tokenId: parse(market.clobTokenIds)[0] ?? "",
    }));
}

/** Events on a theme or name, for find_instruments: each with its priced outcomes. */
export async function findPredictions(
  terms: readonly string[],
): Promise<Omit<Instrument, "venue">[]> {
  const searches = await Promise.all(terms.slice(0, 3).map((term) => searchEvents(term)));
  return searches.flatMap((events) =>
    events.flatMap((event) => {
      const outcomes = eventOutcomes(event.markets);
      if (outcomes.length === 0) return [];
      return [
        {
          kind: "prediction",
          tool: "polymarket_order",
          name: event.title,
          ticker: event.slug,
          chain: "polygon",
          identifier: event.slug,
          price: outcomes[0]?.price ?? null,
          liquidityUsd: event.liquidity ?? null,
          volume24hUsd: event.volume24hr ?? null,
          logoUrl: event.icon ?? event.image ?? null,
          outcomes,
        },
      ];
    }),
  );
}
