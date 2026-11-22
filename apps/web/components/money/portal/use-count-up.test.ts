import { describe, expect, it } from "vitest";

import { countUpAt } from "./use-count-up";

const WHOLE = 250_000_000n; // $250
const WITH_CENTS = 250_370_000n; // $250.37

describe("countUpAt", () => {
  it("climbs in whole dollars to a whole amount, quickly at first", () => {
    const halfway = countUpAt(WHOLE, 450, 900);
    expect(halfway % 1_000_000n).toBe(0n);
    expect(halfway).toBeGreaterThan(WHOLE / 2n);
    expect(halfway).toBeLessThan(WHOLE);
  });

  it("climbs in cents to an amount with cents, so it never widens at the end", () => {
    expect(countUpAt(WITH_CENTS, 450, 900) % 10_000n).toBe(0n);
    expect(countUpAt(WITH_CENTS, 450, 900) % 1_000_000n).not.toBe(0n);
  });

  it("never reads zero once counting starts, even for a small test send", () => {
    for (const to of [1_000_000n, 500_000n, 10_000n]) {
      for (let elapsed = 0; elapsed <= 900; elapsed += 15) {
        const shown = countUpAt(to, elapsed, 900);
        expect(shown).toBeGreaterThan(0n);
        expect(shown).toBeLessThanOrEqual(to);
      }
    }
  });

  it("climbs on from the figure shown when a later deposit takes its place", () => {
    const real = 500_000_000n; // $500
    const start = countUpAt(real, 0, 900, WITH_CENTS);
    expect(start).toBe(WHOLE);
    const halfway = countUpAt(real, 450, 900, WITH_CENTS);
    expect(halfway).toBeGreaterThan(WHOLE);
    expect(halfway).toBeLessThan(real);
    expect(countUpAt(real, 900, 900, WITH_CENTS)).toBe(real);
  });

  it("lands on the exact amount", () => {
    expect(countUpAt(WITH_CENTS, 900, 900)).toBe(WITH_CENTS);
    expect(countUpAt(WHOLE, 5_000, 900)).toBe(WHOLE);
  });
});
