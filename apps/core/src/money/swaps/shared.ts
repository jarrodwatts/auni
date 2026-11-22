import type { Cost } from "../effect.ts";
import { fillIdentity, QUANTITY_DECIMALS, type FillKey } from "../fill-key.ts";
import type { SpecialistHolds } from "../recipe.ts";

/**
 * How much of a trade's dollars it may lose the moment it fills before a
 * specialist won't make it on its own, and code won't pay for a card with it.
 * Slippage only holds a swap to its own quote, and a thin or seeded pool
 * quotes its own loss. Specialists have no loss limit a person set, so this
 * stands in for one; every card shows the loss itself in dollars.
 */
export const MAX_BUY_IMPACT_PCT = 5;

/**
 * What a trade costs on its card: what it loses to the market at the token's
 * price, once that reaches a cent. Unknown without a price, and nothing when
 * it fills better than the market.
 */
export function tradeCosts(impactUsd: number | null): Cost[] {
  return impactUsd !== null && impactUsd >= 0.01 ? [{ label: "price move", usd: impactUsd }] : [];
}

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchJson<T>(
  url: string | URL,
  options: { readonly timeoutMs?: number; readonly init?: RequestInit } = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options.init,
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      `${new URL(url).host} answered ${response.status}: ${text.slice(0, 300)}`,
      response.status,
    );
  }
  return JSON.parse(text) as T;
}

/** The promise's answer, or a rejection once `ms` pass without one. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1_000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** What lets go of each thing kept for a while (see cached), for forgetKept. */
const keepers: (() => void)[] = [];

/** Has forgetKept clear something kept for a while outside `cached`. */
export function onForget(forget: () => void): void {
  keepers.push(forget);
}

/**
 * Lets go of every answer kept for a while, so the next ask reads afresh. Only a demo calls it,
 * once, as it finishes playing its owner's past at earlier prices (demo/seed.ts).
 */
export function forgetKept(): void {
  for (const forget of keepers) forget();
}

/** Remembers each key's promise for `ttlMs`; a failure is forgotten at once so the next call retries. */
export function cached<T>(
  ttlMs: number,
  load: (key: string) => Promise<T>,
): (key: string) => Promise<T> {
  const entries = new Map<string, { readonly at: number; readonly value: Promise<T> }>();
  onForget(() => entries.clear());
  return (key) => {
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    // Keys can be free text, like searches, so each miss sweeps out what has expired.
    for (const [old, entry] of entries) if (now - entry.at >= ttlMs) entries.delete(old);
    const value = load(key);
    entries.set(key, { at: now, value });
    value.catch(() => entries.delete(key));
    return value;
  };
}

/**
 * A list read now and then that answers with the last copy that loaded, at
 * once, while any reread runs in the background, and fails only while none
 * ever has: reread `rereadMs` after a read, or `retryMs` after a failed one,
 * so an outage doesn't hold up every caller. Each failure goes to `failed`.
 */
export function lastGood<T>(
  load: () => Promise<T>,
  {
    rereadMs,
    retryMs,
    failed,
  }: {
    readonly rereadMs: number;
    readonly retryMs: number;
    readonly failed: (error: unknown) => void;
  },
): () => Promise<T> {
  let latest: { readonly value: T } | null = null;
  let read: { readonly at: number; failed: boolean; readonly value: Promise<T> } | null = null;
  return () => {
    const now = Date.now();
    if (!read || now - read.at >= (read.failed ? retryMs : rereadMs)) {
      const next = { at: now, failed: false, value: load() };
      read = next;
      next.value.then(
        (value) => {
          latest = { value };
        },
        (error: unknown) => {
          next.failed = true;
          failed(error);
        },
      );
    }
    return latest ? Promise.resolve(latest.value) : read.value;
  };
}

/**
 * Decimal amount to integer base units without float drift. The shortest
 * decimal that reads back as the number is the amount meant; digits past the
 * token's decimals are dropped, never rounded up past what was asked for.
 */
export function toBaseUnits(amount: number, decimals: number): bigint {
  const [mantissa = "0", exponent = "0"] = String(amount).split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const scale = decimals + Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  return scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
}

/**
 * What a sell naming no amount sells, in base units: the whole balance, or for
 * a specialist only what its own fills hold of it, never past the balance. A
 * specialist holding the token alone holds all of it, so nothing is left behind.
 */
export function wholeSale(
  balance: bigint,
  key: FillKey,
  decimals: number,
  specialistHolds: SpecialistHolds | undefined,
): bigint {
  if (!specialistHolds) return balance;
  const share =
    (specialistHolds.get(fillIdentity(key)) ?? 0n) / 10n ** BigInt(QUANTITY_DECIMALS - decimals);
  if (share <= 0n) return 0n;
  return share < balance ? share : balance;
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export function usd(value: number): string {
  return value.toFixed(2);
}
