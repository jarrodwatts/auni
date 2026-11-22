/** "-12.3456" in base units of `decimals`, exactly; digits past `decimals` are dropped. */
export function decimalToBaseUnits(value: string, decimals: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0"));
  return negative ? -units : units;
}

/** Core speaks dollars as decimal strings; the screens read USDC base units. */
export function dollarsToBaseUnits(dollars: string): bigint {
  return decimalToBaseUnits(dollars, 6);
}

export function usdc(baseUnits: bigint) {
  return { baseUnits: baseUnits.toString(), currency: { code: "USDC", decimals: 6 } };
}
