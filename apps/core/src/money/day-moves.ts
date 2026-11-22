import { setTimeout as sleep } from "node:timers/promises";

import { movedUsd, perpSize, priceAt, priceKey, pricePaths, type PricePoint } from "./history.ts";
import type { Holding } from "./portfolio.ts";
import { centsToUsd } from "./usd.ts";

/**
 * Each holding's move today, for the green and red on its row: since the
 * person's own midnight, at today's quantity, priced through the same shared
 * history as the line and a specialist's "today" (money/value-history.ts), so
 * for anything held all day the rows add up to it. Cash never moves;
 * anything without a readable price history is null rather than a made-up zero.
 */

/** Signed dollars the holding moved since `since`, e.g. "-3.20"; null when it can't be told. */
export function dayMoveUsd(
  holding: Holding,
  path: readonly PricePoint[] | null,
  since: number,
): string | null {
  if (holding.cash) return "0.00";
  // A path that starts later, like one holding only its live price, can't say what it was then.
  if (holding.usdValue === null || !path?.[0] || path[0].at > since) return null;
  const now = Number(holding.usdValue);
  // Its value then: today's moved back from its price now (the path's end) to its price then.
  const then = movedUsd(now, perpSize(holding), path.at(-1)!.price, priceAt(path, since));
  const dollars = now - then;
  return Number.isFinite(dollars) ? centsToUsd(BigInt(Math.round(dollars * 100))) : null;
}

/** A row's colour is decoration: past this it goes without, and the read still fills the cache. */
const QUOTE_WAIT_MS = 2_000;

/** Every holding's move since `since`, in order; a slow or failed source leaves its rows null. */
export async function dayMoves(
  holdings: readonly Holding[],
  since: number,
): Promise<(string | null)[]> {
  const paths = pricePaths(
    holdings.flatMap((holding) => priceKey(holding) ?? []),
    "15m",
    Date.now(),
  );
  return Promise.all(
    holdings.map(async (holding) => {
      const key = priceKey(holding);
      const path = key
        ? await Promise.race([paths.get(key) ?? Promise.resolve(null), sleep(QUOTE_WAIT_MS, null)])
        : null;
      return dayMoveUsd(holding, path, since);
    }),
  );
}
