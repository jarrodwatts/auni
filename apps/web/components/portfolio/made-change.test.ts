import { describe, expect, it } from "vitest";

import { madeChange } from "./made-change";

const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const reading = (at: number, value: number, made: number) => ({
  at,
  value: usd(value),
  made: usd(made),
});

describe("madeChange", () => {
  it("counts money taken out at the end as at work until it left", () => {
    // $100 earns $10, then all $110 is withdrawn.
    const move = madeChange([reading(0, 100, 0), reading(9, 110, 10), reading(10, 0, 10)]);
    expect(move?.change).toBe(usd(10));
    expect(move?.percent).toBeCloseTo(10);
  });

  it("counts a deposit for the share of the period it was at work", () => {
    // $26, then $50 deposited a third of the way in, then $0.38 made.
    const move = madeChange([reading(0, 26, 0), reading(1, 76, 0), reading(3, 76.38, 0.38)]);
    expect(move?.change).toBe(usd(0.38));
    expect(move?.percent).toBeCloseTo((0.38 / (26 + 50 * (2 / 3))) * 100);
  });

  it("has no move without readings", () => {
    expect(madeChange([])).toBeNull();
  });
});
