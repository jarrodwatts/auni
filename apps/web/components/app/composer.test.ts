import { describe, expect, it } from "vitest";

import { draftAfter, landFocusRequest } from "./composer";

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

/** The box as a focus request sees it: its words, whether it's focused, and its caret. */
function box(value: string) {
  return {
    value,
    focused: false,
    caret: [0, 0],
    focus() {
      this.focused = true;
    },
    setSelectionRange(start: number, end: number) {
      this.caret = [start, end];
    },
  };
}

// Picking a starting point whose words were already in the box left the caret at their start
// (2026-11-25, live in the demo).
describe("landFocusRequest", () => {
  it("focuses the box with the caret at the end of its words, new or already there", () => {
    for (const before of ["", "Buy $250 of Nvidia"]) {
      const input = box(before);
      expect(landFocusRequest(input, request("Buy $250 of Nvidia", true))).toBe(
        "Buy $250 of Nvidia",
      );
      expect(input.focused).toBe(true);
      expect(input.caret).toEqual([18, 18]);
    }
  });
});
