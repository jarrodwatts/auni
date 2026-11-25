import type { DepositWire } from "@auni/shared";

import { dollarsToBaseUnits } from "@/lib/data/usdc";

/** A wait for money to come in, told by the deposits core records (see GET /portfolio). */
export interface DepositWatch {
  /** The deposits already there as the wait began; null until the money is read. */
  readonly seen: ReadonlySet<string> | null;
  /** Every deposit recorded since, newest first. */
  readonly landed: readonly DepositWire[];
}

export const NOT_WATCHED: DepositWatch = { seen: null, landed: [] };

/**
 * The watch once these deposits are read: those there at its first read are old news, and each
 * one after them joins what landed, so a test send and the real one after it both count. A
 * deposit stays landed once the read stops listing it. The same watch back when nothing changed.
 */
export function watchRead(watch: DepositWatch, deposits: readonly DepositWire[]): DepositWatch {
  if (!watch.seen) return { seen: new Set(deposits.map(({ id }) => id)), landed: [] };
  const { seen } = watch;
  const known = new Set(watch.landed.map(({ id }) => id));
  const fresh = deposits.filter(({ id }) => !seen.has(id) && !known.has(id));
  return fresh.length > 0 ? { seen, landed: [...fresh, ...watch.landed] } : watch;
}

/** What landed, all together, in USDC base units. */
export function landedTotal(landed: readonly DepositWire[]): bigint {
  return landed.reduce((total, { usdValue }) => total + dollarsToBaseUnits(usdValue), 0n);
}

/**
 * What a card that asked for `need` whole dollars still waits for once this much landed, in
 * base units; zero once it's covered, or when nothing was asked.
 */
export function stillNeeded(need: string | null, total: bigint): bigint {
  if (!need) return 0n;
  const left = dollarsToBaseUnits(need) - total;
  return left > 0n ? left : 0n;
}
