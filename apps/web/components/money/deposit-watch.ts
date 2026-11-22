import type { DepositWire } from "@auni/shared";

/** A wait for money to come in, told by the deposits core records (see GET /portfolio). */
export interface DepositWatch {
  /** The deposits already there as the wait began; null until the money is read. */
  readonly seen: ReadonlySet<string> | null;
  /** The newest deposit since, once one is recorded. */
  readonly landed: DepositWire | null;
}

/**
 * The watch once these deposits are read: those there at its first read are
 * old news, and the newest one after them is what landed, so the real send
 * after a test send, or after a few cents of dust, takes its place. The same
 * watch back when nothing changed.
 */
export function watchRead(watch: DepositWatch, deposits: readonly DepositWire[]): DepositWatch {
  if (!watch.seen) return { seen: new Set(deposits.map(({ id }) => id)), landed: null };
  const { seen } = watch;
  const newest = deposits.find(({ id }) => !seen.has(id));
  return newest && newest.id !== watch.landed?.id ? { seen, landed: newest } : watch;
}
