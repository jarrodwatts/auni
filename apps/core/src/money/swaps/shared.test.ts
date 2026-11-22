import { describe, expect, it } from "vitest";

import { toBaseUnits } from "./shared.ts";

describe("toBaseUnits", () => {
  it("never rounds a spend up past what was asked for", () => {
    expect(toBaseUnits(1.9999999, 6)).toBe(1_999_999n);
    expect(toBaseUnits(0.1234567, 6)).toBe(123_456n);
    expect(toBaseUnits(5e-7, 6)).toBe(0n);
  });

  it("reads amounts as written, not as their float error", () => {
    expect(toBaseUnits(0.29, 6)).toBe(290_000n);
    expect(toBaseUnits(50.29, 6)).toBe(50_290_000n);
    expect(toBaseUnits(1.23e-5, 8)).toBe(1_230n);
  });

  it("scales whole amounts to any decimals", () => {
    expect(toBaseUnits(0, 6)).toBe(0n);
    expect(toBaseUnits(1.5, 18)).toBe(1_500_000_000_000_000_000n);
    expect(toBaseUnits(1e21, 6)).toBe(10n ** 27n);
  });
});
