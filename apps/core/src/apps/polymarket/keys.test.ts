import { describe, expect, it } from "vitest";

import { isOutcome } from "./keys.ts";

describe("isOutcome", () => {
  it("tells an outcome from Polygon's own coin and its tokens", () => {
    expect(
      isOutcome({
        chain: "polygon",
        instrument: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      }),
    ).toBe(true);
    expect(isOutcome({ chain: "polygon", instrument: "native" })).toBe(false);
    expect(
      isOutcome({ chain: "polygon", instrument: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" }),
    ).toBe(false);
  });
});
