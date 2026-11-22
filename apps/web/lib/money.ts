import { dollarsToBaseUnits } from "./data/usdc";

/** USDC base units in one cent. */
const USDC_CENT = 10_000n;

const GLANCEABLE_USD = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  trailingZeroDisplay: "stripIfInteger",
});

/** Whole amounts read as "$80"; anything with cents keeps both digits ("$1,018.40"). */
export function formatGlanceableUsd(dollars: number): string {
  return `$${GLANCEABLE_USD.format(dollars)}`;
}

export function formatUsdcBalance(baseUnits: bigint): string {
  // A balance shouldn't go below zero, but one a venue reports that way shows signed rather than blanking the page.
  if (baseUnits < 0n) return formatUsdcChange(baseUnits);
  const cents = ((baseUnits + USDC_CENT / 2n) / USDC_CENT) * USDC_CENT;
  return formatGlanceableUsd(Number(cents) / 1_000_000);
}

/** Core's decimal-dollar strings ("1840.5") read the same as every balance ("$1,840.50"). */
export function formatUsd(dollars: string): string {
  return formatUsdcBalance(dollarsToBaseUnits(dollars));
}

/** Dollar-pegged base units as money exact to the unit ("$1,000.50", "$80"), for terms a person approves. */
export { formatExactUsd } from "@auni/shared";

const ASSET_PRICE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const SMALL_ASSET_PRICE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

/** One unit of an asset at market: "$81.30", and a sub-dollar token to four places ("$0.0412"). */
export function formatAssetPrice(dollars: number): string {
  return (dollars < 1 ? SMALL_ASSET_PRICE : ASSET_PRICE).format(dollars);
}

/** "$150.00" reads as "$150" in a title; any cents stay. */
export function trimCents(value: string): string {
  return value.endsWith(".00") ? value.slice(0, -3) : value;
}

const MINUS = "−";

/** A signed move in money, rounded to the cent first so "+$0.00" never shows. */
export function formatUsdcChange(baseUnits: bigint): string {
  const magnitude = baseUnits < 0n ? -baseUnits : baseUnits;
  const cents = (magnitude + USDC_CENT / 2n) / USDC_CENT;
  const sign = cents === 0n ? "" : baseUnits < 0n ? MINUS : "+";
  return `${sign}${formatUsdcBalance(cents * USDC_CENT)}`;
}

/** The move as a percent of where it started: a +$18 day on $2,291 is +0.8%. */
export function changePercent(changeBaseUnits: bigint, valueBaseUnits: bigint): number {
  const start = valueBaseUnits - changeBaseUnits;
  return start > 0n ? (Number(changeBaseUnits) / Number(start)) * 100 : 0;
}

export function formatPercentChange(percent: number): string {
  const tenths = Math.round(percent * 10);
  const sign = tenths > 0 ? "+" : tenths < 0 ? MINUS : "";
  return `${sign}${(Math.abs(tenths) / 10).toFixed(1)}%`;
}
