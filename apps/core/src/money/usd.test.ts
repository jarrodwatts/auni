import { describe, expect, it } from "vitest";

import { centsToUsd, formatUnits, normalizeUsd, parseUnits, sumUsd, usdToCents } from "./usd.ts";

describe("usd arithmetic", () => {
  it("parses and prints cents exactly", () => {
    expect(usdToCents("12")).toBe(1200n);
    expect(usdToCents("12.5")).toBe(1250n);
    expect(usdToCents("12.349")).toBe(1235n);
    expect(centsToUsd(1205n)).toBe("12.05");
  });

  it("says an amount to the nearest cent, and rounds only a bound up or down", () => {
    // A bridge of 1.010787 USDC is "$1.01", a payout of 1.004 "$1.00" (findings 92 and 100).
    expect(normalizeUsd("1.010787")).toBe("1.01");
    expect(normalizeUsd("1.004")).toBe("1.00");
    expect(normalizeUsd("1.005")).toBe("1.01");
    expect(normalizeUsd("0.000001")).toBe("0.00");
    // The most a move may spend never comes in under it; the least it lands never over.
    expect(normalizeUsd("1.010787", "up")).toBe("1.02");
    expect(normalizeUsd("0.000001", "up")).toBe("0.01");
    expect(usdToCents("1.019999", "down")).toBe(101n);
    expect(usdToCents("1.01", "up")).toBe(101n);
  });

  it("sums in exact cents", () => {
    expect(sumUsd(["0.10", "0.20"])).toBe("0.30");
    expect(sumUsd([])).toBe("0.00");
  });

  it("rejects anything that is not a plain nonnegative decimal", () => {
    for (const bad of ["-1", "1e3", "", "abc", "1.2.3"]) {
      expect(() => usdToCents(bad)).toThrow();
    }
  });

  it("converts base units both ways", () => {
    expect(formatUnits(1_234_567n, 6)).toBe("1.234567");
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(parseUnits("1.2345678", 6)).toBe(1_234_567n);
    expect(parseUnits("50", 6)).toBe(50_000_000n);
  });
});
