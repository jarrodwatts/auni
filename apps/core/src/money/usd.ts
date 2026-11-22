// Dollar amounts travel as decimal strings and are compared as integer cents.
// Floats never touch money: 0.1 + 0.2 is not 0.3.

const DECIMAL = /^(\d+)(?:\.(\d+))?$/u;

/**
 * How a dollar amount is taken to whole cents, by what it means, so a card, a chat and Activity
 * never say more than happened:
 * - "nearest", the default: what an amount is, as it's said or recorded ($1.0108 is $1.01).
 * - "up": the most a move may spend, which a tap allows and a plan must have (an action's
 *   amountUsd, held to it by assertApprovedSpend; what a place needs).
 * - "down": the least a move promises, as what a bridge lands at least.
 */
export type Rounding = "nearest" | "up" | "down";

/** Parses a nonnegative decimal string into cents, rounding any sub-cent part as it means. */
export function usdToCents(value: string, rounding: Rounding = "nearest"): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`Not a dollar amount: ${value}`);
  const whole = BigInt(match[1] ?? "0");
  const fraction = match[2] ?? "";
  const cents = BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  const rest = fraction.slice(2);
  const carry = { nearest: (rest[0] ?? "0") >= "5", up: /[1-9]/u.test(rest), down: false };
  return whole * 100n + cents + (carry[rounding] ? 1n : 0n);
}

/** usdToCents for an amount a venue may report below zero, like an account's value. */
export function signedUsdToCents(value: string): bigint {
  return value.startsWith("-") ? -usdToCents(value.slice(1)) : usdToCents(value);
}

export function centsToUsd(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

/** Normalizes any nonnegative decimal string to exactly two places, rounded as it means. */
export function normalizeUsd(value: string, rounding: Rounding = "nearest"): string {
  return centsToUsd(usdToCents(value, rounding));
}

export function sumUsd(values: readonly string[]): string {
  return centsToUsd(values.reduce((total, value) => total + usdToCents(value), 0n));
}

/** Scales an integer amount of base units (e.g. USDC's 6 decimals) into a decimal string. */
export function formatUnits(baseUnits: bigint, decimals: number): string {
  const sign = baseUnits < 0n ? "-" : "";
  const absolute = baseUnits < 0n ? -baseUnits : baseUnits;
  if (decimals === 0) return `${sign}${absolute}`;
  const scale = 10n ** BigInt(decimals);
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return `${sign}${absolute / scale}${fraction ? `.${fraction}` : ""}`;
}

/**
 * What `units` base units are worth at a price per whole unit, in dollars,
 * signed as they are: the price taken to 1e-8 dollars in integers, then cents.
 */
export function unitsUsd(units: bigint, decimals: number, price: number): string {
  const priceUnits = BigInt(Math.round(price * 1e8));
  return centsToUsd((units * priceUnits * 100n) / (10n ** BigInt(decimals) * 10n ** 8n));
}

/** parseUnits for an amount that may be below zero, like what a trade lost. */
export function signedUnits(value: string, decimals: number): bigint {
  return value.startsWith("-")
    ? -parseUnits(value.slice(1), decimals)
    : parseUnits(value, decimals);
}

/** Parses a nonnegative decimal string into base units, truncating extra precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`Not a decimal amount: ${value}`);
  const fraction = (match[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) + BigInt(fraction || "0");
}
