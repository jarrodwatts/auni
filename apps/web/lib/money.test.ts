import { describe, expect, it } from "vitest";

import {
  changePercent,
  formatExactUsd,
  formatPercentChange,
  formatUsd,
  formatUsdcBalance,
  formatUsdcChange,
} from "./money";

describe("money display", () => {
  it("shows balances at two decimals, dust rounded away", () => {
    expect(formatUsdcBalance(25_001_671n)).toBe("$25");
    expect(formatUsdcBalance(1_001_671n)).toBe("$1");
    expect(formatUsdcBalance(25_100_000n)).toBe("$25.10");
    expect(formatUsdcBalance(1_234_567_890_123n)).toBe("$1,234,567.89");
    expect(formatUsdcBalance(10_000_000_000n)).toBe("$10,000");
    expect(formatUsdcBalance(0n)).toBe("$0");
    // Half a cent rounds up, and the digits below it never leak out.
    expect(formatUsdcBalance(5_000n)).toBe("$0.01");
    expect(formatUsdcBalance(4_999n)).toBe("$0");
  });

  it("shows a negative balance signed instead of failing the page", () => {
    expect(formatUsdcBalance(-3_000_000n)).toBe("−$3");
    expect(formatUsdcBalance(-1n)).toBe("$0");
  });

  it("reads core's dollar strings exactly as it reads balances", () => {
    expect(formatUsd("1840.5")).toBe("$1,840.50");
    expect(formatUsd("150.00")).toBe("$150");
    expect(formatUsd("0.005")).toBe("$0.01");
  });

  it("shows terms exact to the base unit", () => {
    expect(formatExactUsd("1000500000", 6)).toBe("$1,000.50");
    expect(formatExactUsd("80000000", 6)).toBe("$80");
    expect(formatExactUsd("1234567", 6)).toBe("$1.234567");
    expect(formatExactUsd("5", 6)).toBe("$0.000005");
  });
});

describe("money moves", () => {
  it("signs a change after rounding it to the cent", () => {
    expect(formatUsdcChange(18_170_000n)).toBe("+$18.17");
    expect(formatUsdcChange(-3_000_000n)).toBe("−$3");
    expect(formatUsdcChange(4_000n)).toBe("$0");
    expect(formatUsdcChange(-4_000n)).toBe("$0");
  });

  it("measures a move against where the day started", () => {
    expect(changePercent(18_170_000n, 2_291_400_000n)).toBeCloseTo(0.799, 2);
    expect(changePercent(-3_000_000n, 247_000_000n)).toBeCloseTo(-1.2, 2);
    expect(changePercent(5_000_000n, 5_000_000n)).toBe(0);
  });

  it("shows a percent at one decimal with a real minus sign", () => {
    expect(formatPercentChange(1.8)).toBe("+1.8%");
    expect(formatPercentChange(-1.2)).toBe("−1.2%");
    expect(formatPercentChange(0.04)).toBe("0.0%");
  });
});
