import { describe, expect, it } from "vitest";

import { playPricesAt, TODAY, usdOf } from "./prices.ts";

// The app measures "today" from the owner's midnight, so the demo's prices must read the same at
// any hour it is run: a screenshot taken in the morning and one at night show the same figures.
const HOUR_MS = 60 * 60_000;

describe("the demo's prices", () => {
  it("stand still through today, once its first hour has played", () => {
    for (const hour of [1, 9, 15, 23.9])
      expect(usdOf("SOL", TODAY + hour * HOUR_MS)).toBe(usdOf("SOL", TODAY + HOUR_MS));
  });

  it("start today from one price, whichever minute of the hour before midnight is read", () => {
    for (const minutes of [0, 7, 59])
      expect(usdOf("SOL", TODAY - minutes * 60_000)).toBe(usdOf("SOL", TODAY));
  });

  it("move today, and moved before it", () => {
    expect(usdOf("SOL", TODAY + 2 * HOUR_MS)).not.toBe(usdOf("SOL", TODAY));
    expect(usdOf("SOL", TODAY - 3 * 24 * HOUR_MS)).not.toBe(usdOf("SOL", TODAY));
  });

  // A step of the owner's past takes a few seconds to play, a different few on every run. What
  // it paid must not depend on them.
  it("stand at a step's own moment for as long as the step plays", () => {
    const then = TODAY - 3 * 24 * HOUR_MS;
    const [atThen, before] = [usdOf("SOL", then), usdOf("SOL", then - 6 * HOUR_MS)];
    expect(before).not.toBe(atThen);
    const lagMs = Date.now() - then;
    playPricesAt(then, lagMs);
    try {
      expect(usdOf("SOL")).toBe(atThen);
      // Seconds into the step, by the clock or by the time a row was written, it is the same.
      expect(usdOf("SOL", Date.now() + 4_000)).toBe(atThen);
      expect(usdOf("SOL", then + lagMs + 2_500)).toBe(atThen);
      // A moment before the step is still that long before it.
      expect(usdOf("SOL", then + lagMs - 6 * HOUR_MS)).toBe(before);
    } finally {
      playPricesAt();
    }
    expect(usdOf("SOL", then - 6 * HOUR_MS)).toBe(before);
  });
});
