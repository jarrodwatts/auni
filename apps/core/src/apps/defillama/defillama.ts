import type { Tokens } from "../contract.ts";
import type { PricePoint, TokenPrice } from "../../money/history.ts";
import { cached, fetchJson } from "../../money/swaps/shared.ts";

/**
 * DefiLlama, which prices tokens and stocks with no key, by the coin ids core's price ids
 * already are ("coingecko:solana", "monad:0x…"). Every read of it is here.
 */

const LLAMA = "https://coins.llama.fi";
const TIMEOUT_MS = 10_000;

/**
 * These coins' prices: now, or with `at` its nearest within four hours of then. A coin it has no
 * price for is absent. It answers 414 once a URL carries about 150 ids, which is why core asks
 * for 100 at most.
 */
export async function prices(
  ids: readonly string[],
  at?: Date,
): Promise<ReadonlyMap<string, TokenPrice>> {
  const path = at
    ? `prices/historical/${Math.floor(at.getTime() / 1_000)}/${ids.join(",")}?searchWidth=4h`
    : `prices/current/${ids.join(",")}`;
  const body = await fetchJson<{ coins: Record<string, TokenPrice> }>(`${LLAMA}/${path}`, {
    timeoutMs: TIMEOUT_MS,
  });
  return new Map(Object.entries(body.coins));
}

type ChartStep = Parameters<NonNullable<Tokens["history"]>>[1];

const STEP_MS: Readonly<Record<ChartStep, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/**
 * How far from each point a price may be found, where its own default (a tenth of the step)
 * is too narrow: stocks are priced every half hour, and this finds one for each short step.
 */
const SEARCH_WIDTH: Readonly<Partial<Record<ChartStep, string>>> = { "15m": "1h", "1h": "1h" };

/**
 * A coin's chart from `from` (milliseconds) to now, a point each step, oldest first, each
 * stamped in milliseconds. Empty when it keeps none: it has no history of a chain it doesn't
 * name. It gives at most 500 points a call, across every coin asked for, so one coin a call.
 */
export async function history(id: string, step: ChartStep, from: number): Promise<PricePoint[]> {
  if (id.startsWith("eip155:")) return [];
  const span = Math.floor((Date.now() - from) / STEP_MS[step]) + 1;
  const width = SEARCH_WIDTH[step] ? `&searchWidth=${SEARCH_WIDTH[step]}` : "";
  const body = await fetchJson<{
    coins: Record<string, { prices: { timestamp: number; price: number }[] }>;
  }>(`${LLAMA}/chart/${id}?start=${Math.floor(from / 1_000)}&span=${span}&period=${step}${width}`, {
    timeoutMs: TIMEOUT_MS,
  });
  return (Object.values(body.coins)[0]?.prices ?? []).map((point) => ({
    at: point.timestamp * 1_000,
    price: point.price,
  }));
}

/** A coin's price now and its percent change over the last day, each kept a minute. */
export const day = cached(60_000, async (id) => {
  const [current, change] = await Promise.all([
    prices([id]),
    fetchJson<{ coins: Record<string, number> }>(`${LLAMA}/percentage/${id}?period=24h`),
  ]);
  return { price: [...current.values()][0]?.price, today: Object.values(change.coins)[0] };
});
