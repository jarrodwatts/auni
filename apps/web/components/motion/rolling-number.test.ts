import { describe, expect, it } from "vitest";

import { rollingSlots } from "./rolling-number";

describe("rollingSlots", () => {
  it("keys numeric digits from the right so place values stay aligned across carryovers", () => {
    const nine = rollingSlots("9s");
    const ten = rollingSlots("10s");

    expect(nine).toEqual([
      { key: "d-0-0", char: "9", isDigit: true },
      { key: "t-1-s", char: "s", isDigit: false },
    ]);
    expect(ten).toEqual([
      { key: "d-0-1", char: "1", isDigit: true },
      { key: "d-0-0", char: "0", isDigit: true },
      { key: "t-2-s", char: "s", isDigit: false },
    ]);
  });

  it("handles multi-part minute and second durations", () => {
    expect(rollingSlots("1m 5s")).toEqual([
      { key: "d-0-0", char: "1", isDigit: true },
      { key: "t-1-m ", char: "m ", isDigit: false },
      { key: "d-1-0", char: "5", isDigit: true },
      { key: "t-3-s", char: "s", isDigit: false },
    ]);
  });
});
