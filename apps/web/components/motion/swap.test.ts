import { describe, expect, it } from "vitest";

import { swapGone, swapOf, swapTo } from "./swap";

describe("swap", () => {
  it("starts on its first value with nothing leaving", () => {
    expect(swapOf("Checking live prices")).toEqual({
      current: "Checking live prices",
      id: 0,
      leaving: [],
    });
  });

  it("sends the old value out under the id it had, so its element carries on", () => {
    const swap = swapTo(swapOf("Checking live prices"), "Checked live prices", true);
    expect(swap).toEqual({
      current: "Checked live prices",
      id: 1,
      leaving: [{ id: 0, value: "Checking live prices" }],
    });
  });

  it("keeps every value still leaving when changes come quickly", () => {
    const swap = swapTo(swapTo(swapOf("a"), "b", true), "c", true);
    expect(swap.current).toBe("c");
    expect(swap.id).toBe(2);
    expect(swap.leaving).toEqual([
      { id: 0, value: "a" },
      { id: 1, value: "b" },
    ]);
  });

  it("swaps in place, with nothing leaving, when it shouldn't animate", () => {
    const swap = swapTo(swapOf("a"), "b", false);
    expect(swap).toEqual({ current: "b", id: 0, leaving: [] });
  });

  it("forgets a value once it has gone, and only that one", () => {
    const swap = swapTo(swapTo(swapOf("a"), "b", true), "c", true);
    expect(swapGone(swap, 0).leaving).toEqual([{ id: 1, value: "b" }]);
    expect(swapGone(swap, 0).current).toBe("c");
  });
});
