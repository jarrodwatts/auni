import { describe, expect, it } from "vitest";

import { CoreApiError } from "@/lib/core";

import { NOT_REACHED, tapFailed } from "./actions";

describe("tapFailed", () => {
  // Core refuses a card drawn before cards said every permission; the card says why, not "lost".
  it("says core's words for a card it refused as out of date, and NOT_REACHED for the rest", () => {
    const outOfDate = new CoreApiError({
      message: "Core request failed with status 409",
      status: 409,
      code: "out_of_date",
      detail: "This card is out of date. Ask Auni to put it up again.",
    });
    expect(tapFailed(outOfDate)).toBe("This card is out of date. Ask Auni to put it up again.");
    expect(tapFailed(new CoreApiError({ message: "x", status: 502 }))).toBe(NOT_REACHED);
    expect(tapFailed(new TypeError("Failed to fetch"))).toBe(NOT_REACHED);
  });
});
