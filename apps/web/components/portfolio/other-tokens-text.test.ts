import { describe, expect, it } from "vitest";

import { otherTokenLine, otherTokensLabel } from "./other-tokens-text";

describe("otherTokensLabel", () => {
  it("counts them in one row", () => {
    expect(otherTokensLabel(3)).toBe("Other tokens (3)");
    expect(otherTokensLabel(1200)).toBe("Other tokens (1,200)");
  });
});

describe("otherTokenLine", () => {
  it("says what they hold, where, and what a feed says it's worth, or that nothing prices it", () => {
    expect(otherTokenLine({ amount: "1000", usdValue: "40" }, "Base")).toBe(
      "1,000 on Base, worth $40",
    );
    expect(otherTokenLine({ amount: "5.123456789", usdValue: null }, "Base")).toBe(
      "5.12346 on Base, no price",
    );
    expect(otherTokenLine({ amount: null, usdValue: null }, "Base")).toBe(
      "On Base. Couldn't read it just now",
    );
  });
});
