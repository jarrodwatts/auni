import { describe, expect, it } from "vitest";

import { decimalToBaseUnits, dollarsToBaseUnits } from "./usdc";

describe("decimalToBaseUnits", () => {
  it("reads whole, fractional and negative amounts exactly", () => {
    expect(dollarsToBaseUnits("1018.40")).toBe(1_018_400_000n);
    expect(dollarsToBaseUnits("12")).toBe(12_000_000n);
    expect(dollarsToBaseUnits("-2.5")).toBe(-2_500_000n);
    expect(dollarsToBaseUnits("-0.50")).toBe(-500_000n);
  });

  it("drops digits past the precision instead of scaling them", () => {
    expect(decimalToBaseUnits("1.1234567", 6)).toBe(1_123_456n);
    expect(decimalToBaseUnits("3.9", 0)).toBe(3n);
  });
});
