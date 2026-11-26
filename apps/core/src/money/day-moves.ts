import { setTimeout as sleep } from "node:timers/promises";

import { signedQuantity, type PotFill } from "./books.ts";
import { fillIdentity } from "./fill-key.ts";
import { movedUsd, perpSize, priceAt, priceKey, pricePaths, type PricePoint } from "./history.ts";
import type { Holding } from "./portfolio.ts";
import { centsToUsd } from "./usd.ts";

/**
 * Each holding's move today, for the green and red on its row: what it is worth now less what
 * it was worth when today began for it. That is the person's own midnight for what was held
 * then, priced through the same shared history as the line and a take's "today"
 * (money/value-history.ts), so for anything held all day the rows add up to it; and when it was
 * bought for what was bought since, at what it cost (a perp, from its entry), so a take bought
 * this morning moves today exactly as it has since it was bought, never by a move from before
 * it existed. Cash never moves; anything whose move can't be told is null rather than a
 * made-up zero.
 */

/** What a holding's own fills bought of it since the day began: units, and what they cost in dollars (a perp's, at its size). */
export interface Bought {
  readonly units: number;
  readonly usd: number;
}

/** Signed dollars the holding moved since `since`, e.g. "-3.20"; null when it can't be told. */
export function dayMoveUsd(
  holding: Holding,
  path: readonly PricePoint[] | null,
  since: number,
  bought: Bought | null = null,
): string | null {
  if (holding.cash) return "0.00";
  if (holding.usdValue === null) return null;
  const now = Number(holding.usdValue);
  const held = Number(holding.quantity);
  // The part of what's held now that was bought today: all of it, when it all was.
  const part = bought && held > 0 ? Math.min(1, bought.units / held) : 0;
  const latest = path?.at(-1)?.price ?? null;
  const thenParts: (number | null)[] = [];
  if (part < 1) {
    // A path that starts later, like one holding only its live price, can't say what it was then.
    const known = path?.[0] && path[0].at <= since;
    thenParts.push(
      known
        ? movedUsd(now * (1 - part), perpSize(holding, 1 - part), latest, priceAt(path, since))
        : null,
    );
  }
  if (bought && part > 0) {
    const perp = perpSize(holding, part);
    thenParts.push(
      perp
        ? latest === null
          ? null
          : movedUsd(now * part, perp, latest, bought.usd / bought.units)
        : (bought.usd * part * held) / bought.units,
    );
  }
  if (thenParts.includes(null)) return null;
  const dollars = now - (thenParts as number[]).reduce((sum, value) => sum + value, 0);
  return Number.isFinite(dollars) ? centsToUsd(BigInt(Math.round(dollars * 100))) : null;
}

/** A fill as a day's move reads it: what it bought or sold of what, and when. */
export type DayFill = PotFill & { readonly createdAt?: Date };

/**
 * What `fills` added to `holding` since `since`, in its direction (a short's sells), or null for
 * none. Its fills, so a take's are its own and the whole portfolio's are every fill.
 */
function boughtSince(holding: Holding, fills: readonly DayFill[], since: number): Bought | null {
  const key = fillIdentity(holding);
  const direction = holding.short ? -1n : 1n;
  let units = 0;
  let usd = 0;
  for (const fill of fills) {
    if ((fill.createdAt?.getTime() ?? -Infinity) < since || fillIdentity(fill) !== key) continue;
    if (signedQuantity(fill) * direction <= 0n) continue;
    units += Number(fill.quantity);
    usd += Number(fill.usdValue);
  }
  return units > 0 ? { units, usd } : null;
}

/** A row's colour is decoration: past this it goes without, and the read still fills the cache. */
const QUOTE_WAIT_MS = 2_000;

/**
 * Every holding's move since `since`, in order; `fills`, those that bought these holdings (a
 * take's own, or every fill for the whole portfolio). A slow or failed source leaves its rows
 * null, but for what was all bought today, which moves from what it cost.
 */
export async function dayMoves(
  holdings: readonly Holding[],
  since: number,
  fills: readonly DayFill[],
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
      return dayMoveUsd(holding, path, since, boughtSince(holding, fills, since));
    }),
  );
}
