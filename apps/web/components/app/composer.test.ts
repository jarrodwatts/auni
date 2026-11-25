import { describe, expect, it } from "vitest";

import { draftAfter } from "./composer";

const request = (text: string, replace = false) => ({ draftKey: "new", text, replace });

describe("draftAfter", () => {
  it("fills an empty box, and leaves words the owner typed alone", () => {
    expect(draftAfter("", request("Buy $250 of Nvidia"))).toBe("Buy $250 of Nvidia");
    expect(draftAfter("My own take", request("Buy $250 of Nvidia"))).toBe("My own take");
  });

  it("puts a starting point the owner tapped in place of what's there, to read before sending", () => {
    expect(draftAfter("Test the Fed cut", request("Test gold at $4,000", true))).toBe(
      "Test gold at $4,000",
    );
  });

  it("only focuses when there are no words to put in", () => {
    expect(draftAfter("Half typed", request("", true))).toBe("Half typed");
  });
});
