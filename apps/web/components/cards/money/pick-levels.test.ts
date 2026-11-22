import { describe, expect, it } from "vitest";

import { chartLevels } from "./pick-levels";

const threaded = (levels: ReturnType<typeof chartLevels>) =>
  levels.filter((level) => level.threaded).map(({ label }) => label);
const faint = (levels: ReturnType<typeof chartLevels>) =>
  levels.filter((level) => level.faint).map(({ label }) => label);

describe("chartLevels", () => {
  it("threads the stop when it sells before wipe-out, and draws wipe-out back", () => {
    const levels = chartLevels(
      [
        { kind: "take_profit", price: 1000 },
        { kind: "stop", price: 790 },
        { kind: "liquidation", price: 746 },
      ],
      877,
    );
    expect(threaded(levels)).toEqual(["Stop $790, 10% away"]);
    expect(faint(levels)).toEqual(["Wiped out $746"]);
  });

  it("threads wipe-out when a stop sits beyond it, since wipe-out comes first", () => {
    const levels = chartLevels(
      [
        { kind: "stop", price: 70 },
        { kind: "liquidation", price: 80 },
      ],
      100,
    );
    expect(threaded(levels)).toEqual(["Wiped out $80, 20% away"]);
    expect(faint(levels)).toEqual([]);
  });

  it("threads upward for a short, whose losses lie above", () => {
    const levels = chartLevels(
      [
        { kind: "take_profit", price: 80 },
        { kind: "stop", price: 110 },
        { kind: "liquidation", price: 130 },
      ],
      100,
    );
    expect(threaded(levels)).toEqual(["Stop $110, 10% away"]);
  });
});
