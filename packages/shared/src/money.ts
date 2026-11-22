import { z } from "zod";

const UINT256_MAX = (1n << 256n) - 1n;
const CANONICAL_BASE_UNITS = /^(0|[1-9]\d*)$/;

/** JSON-safe uint256 representation shared by money and chain counters. */
const baseUnitAmountWireSchema = z
  .string()
  .max(78, "must fit within a 256-bit base-unit amount")
  .regex(CANONICAL_BASE_UNITS, "must be a canonical nonnegative integer")
  .refine(
    (value) => !CANONICAL_BASE_UNITS.test(value) || BigInt(value) <= UINT256_MAX,
    "must fit within uint256",
  );

/** Dollars as core writes them: a decimal string, signed for a change ("12.50", "-3.10"). */
export const dollarsSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/u, "must be a decimal dollar string");

const currencySchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9.]{2,12}$/),
  decimals: z.int().min(0).max(30),
});

/** JSON-safe representation used at HTTP, queue, database, and audit boundaries. */
export const moneyWireSchema = z.object({
  baseUnits: baseUnitAmountWireSchema,
  currency: currencySchema,
});
export type MoneyWire = z.infer<typeof moneyWireSchema>;

const EXACT_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
  trailingZeroDisplay: "stripIfInteger",
});

/** Dollar-pegged base units as money exact to the unit ("$1,000.50", "$80"), for terms a person approves. */
export function formatExactUsd(baseUnits: string, decimals: number): string {
  const padded = baseUnits.padStart(decimals + 1, "0");
  const point = padded.length - decimals;
  return EXACT_USD.format(
    `${padded.slice(0, point)}.${padded.slice(point)}` as Intl.StringNumericLiteral,
  );
}

export const usdcMoneyWireSchema = moneyWireSchema.refine(
  ({ currency }) => currency.code === "USDC" && currency.decimals === 6,
  "must use USDC with 6 decimals",
);
export type UsdcMoneyWire = z.infer<typeof usdcMoneyWireSchema>;
