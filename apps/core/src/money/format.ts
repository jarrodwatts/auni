import { dollars } from "./summaries.ts";

// Numbers a person reads on a card or in a summary. Tool inputs and stored
// amounts stay exact decimal strings; these are only for display.

/** Dollars: "$50", "$1,234.50". */
export function usdLabel(value: number): string {
  return dollars(value.toFixed(2));
}

/**
 * A fee: "$1.27", or "under $0.01" for one too small to reach a cent, which
 * as "$0" beside its rate ("$0 (0.5%)") reads as if nothing were charged.
 */
export function feeLabel(value: number): string {
  return value > 0 && value < 0.01 ? "under $0.01" : usdLabel(value);
}

/** A unit price: "$82,948", "$336.62", "$0.6234". */
export function priceLabel(value: number): string {
  const digits =
    value >= 10_000
      ? { maximumFractionDigits: 0 }
      : value >= 1
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { maximumSignificantDigits: 4 };
  return `$${value.toLocaleString("en-US", digits)}`;
}

/** "0x1a2b3c…9f8e": the first six and last four characters, the ones people check. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A token amount, grouped and never in exponent form: "0.00013", "1,234.5678". */
export function formatAmount(value: number): string {
  return value.toLocaleString(
    "en-US",
    value >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 },
  );
}

/** How much of something is held, to four significant figures: "1,235", "0.5", "3". */
export function heldLabel(quantity: string): string {
  return Number(quantity).toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** "Peptides", "Peptides and AI chips", "Peptides, AI chips and 2 more". */
export function namesLabel(names: readonly string[]): string {
  const [first = "", second, third] = names;
  if (names.length <= 1) return first;
  if (names.length === 2) return `${first} and ${second}`;
  if (names.length === 3) return `${first}, ${second} and ${third}`;
  return `${first}, ${second} and ${names.length - 2} more`.slice(0, 120);
}

const UNIT_USD = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
  useGrouping: false,
});

/** A price per unit to six significant figures, never in e-notation: the agent reads it, and nothing adds it up. */
export function unitUsd(price: number): string {
  return UNIT_USD.format(price);
}
