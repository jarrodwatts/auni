import { afterEach, describe, expect, it, vi } from "vitest";

import { chartRanges, moveLabel } from "./chart-ranges";

afterEach(() => vi.useRealTimers());

/** Noon local time, and a moment `hours` before it. */
function atNoon() {
  const noon = new Date(2026, 9, 24, 12);
  vi.useFakeTimers({ toFake: ["Date"], now: noon });
  return (hours: number) => new Date(noon.getTime() - hours * 3_600_000).toISOString();
}

describe("chartRanges", () => {
  it("offers only Today to money first held since midnight", () => {
    const ago = atNoon();
    expect(chartRanges(ago(3))).toEqual(["Today"]);
  });

  it("offers the week to money first held before midnight, however recently", () => {
    // Bought at 11pm yesterday: Today, from midnight, would leave it out.
    const ago = atNoon();
    expect(chartRanges(ago(13))).toEqual(["Today", "1W"]);
  });

  it("offers the month to money first held just over a week ago, since the week is cut at seven days", () => {
    const ago = atNoon();
    expect(chartRanges(ago(7.2 * 24))).toEqual(["Today", "1W", "1M"]);
  });

  it("stops at the first range that shows everything", () => {
    const ago = atNoon();
    expect(chartRanges(ago(20 * 24))).toEqual(["Today", "1W", "1M"]);
    expect(chartRanges(null)).toEqual([]);
  });
});

describe("moveLabel", () => {
  it("names the period when the move counts from its start", () => {
    const ago = atNoon();
    expect(moveLabel("1W", ago(7 * 24))).toBe("in the past week");
    expect(moveLabel("Today", ago(12))).toBe("today");
  });

  it("says where the move counts from when that is later than the period's start", () => {
    // Histories four hours and eight days old, each offered the shortest period that shows it all.
    const ago = atNoon();
    expect(moveLabel("1W", ago(4))).toBe("since Oct 24");
    expect(moveLabel("1M", ago(8 * 24))).toBe("since Oct 16");
  });
});
