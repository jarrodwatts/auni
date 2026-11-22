import { describe, expect, it } from "vitest";

import type { PriceCondition } from "./condition.ts";
import { MINUTE_MS, observe, replay, step, type Bar } from "./evaluate.ts";

const below: PriceCondition = { market: "BTC", crosses: "below", price: 100 };
const above: PriceCondition = { market: "BTC", crosses: "above", price: 100 };

/** Prices fed one after another, a second apart: when the watch fired. */
function ticks(condition: PriceCondition, prices: readonly number[]): number[] {
  const bars: Bar[] = [];
  let held: boolean | undefined;
  const fired: number[] = [];
  prices.forEach((price, index) => {
    const at = index * 1_000;
    observe(bars, at, price, 24 * 60 * MINUTE_MS);
    const result = step(condition, 0, held, price, bars, at);
    held = result.holds;
    if (result.fires) fired.push(index);
  });
  return fired;
}

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({
  t: t * MINUTE_MS,
  o,
  h,
  l,
  c,
});

describe("a level, live", () => {
  it("fires as the price crosses it, and again only after it crosses back", () => {
    expect(ticks(below, [105, 102, 99, 98, 101, 99])).toEqual([2, 5]);
    expect(ticks(above, [95, 100, 101, 99, 100])).toEqual([1, 4]);
  });

  it("never fires for a level already past when first seen", () => {
    expect(ticks(below, [90, 85, 80])).toEqual([]);
  });
});

describe("a move, live", () => {
  const down: PriceCondition = { market: "BTC", moves: "down", percent: 5, within: "5m" };
  const either: PriceCondition = { market: "BTC", moves: "either", percent: 5, within: "5m" };

  it("fires once the price is that far below the window's high", () => {
    expect(ticks(down, [100, 99, 96, 95, 94, 96])).toEqual([3]);
    expect(ticks(either, [100, 103, 106])).toEqual([2]);
  });

  it("never reaches back before the watch was set up", () => {
    // Bars kept for another watch: 110 an hour before this one was set up at minute 60, 100 since.
    const bars: Bar[] = [];
    for (let minute = 0; minute <= 62; minute += 1)
      observe(bars, minute * MINUTE_MS, minute < 30 ? 110 : 100, 24 * 60 * MINUTE_MS);
    const daily: PriceCondition = { market: "BTC", moves: "down", percent: 5, within: "24h" };
    const since = 60 * MINUTE_MS;
    expect(step(daily, since, false, 100, bars, 62 * MINUTE_MS).fires).toBe(false);
    expect(step(daily, 0, false, 100, bars, 62 * MINUTE_MS).fires).toBe(true);
  });

  it("forgets highs older than its window", () => {
    // A minute bar a second: 100 is ten minutes gone by the time 95 comes.
    const bars: Bar[] = [];
    observe(bars, 0, 100, 5 * MINUTE_MS);
    observe(bars, 10 * MINUTE_MS, 96, 5 * MINUTE_MS);
    const first = step(down, 0, undefined, 96, bars, 10 * MINUTE_MS);
    observe(bars, 10 * MINUTE_MS + 1_000, 95, 5 * MINUTE_MS);
    expect(step(down, 0, first.holds, 95, bars, 10 * MINUTE_MS + 1_000).fires).toBe(false);
    expect(bars).toHaveLength(1);
  });
});

describe("a sleep, replayed from candles", () => {
  it("fires once for a level crossed while asleep, saying when first and how often", () => {
    const missed = [
      bar(0, 105, 106, 104, 105),
      bar(1, 105, 105, 99, 101), // crossed, came back above
      bar(2, 101, 103, 101, 102),
      bar(3, 102, 102, 97, 98), // crossed again
      bar(4, 98, 99, 96, 97),
    ];
    const walked = replay(below, 0, false, missed, 0, MINUTE_MS);
    expect(walked).toEqual({ first: missed[1], times: 2, holds: true });
  });

  it("counts a level left and come back to inside one candle as crossed", () => {
    const walked = replay(below, 0, true, [bar(0, 98, 103, 97, 99)], 0, MINUTE_MS);
    expect(walked.times).toBe(1);
  });

  it("starts a watch first seen asleep from where its first candle opened, without firing on it", () => {
    expect(replay(below, 0, undefined, [bar(0, 90, 92, 88, 91)], 0, MINUTE_MS)).toEqual({
      first: null,
      times: 0,
      holds: true,
    });
    expect(replay(below, 0, undefined, [bar(0, 101, 102, 99, 99)], 0, MINUTE_MS).times).toBe(1);
  });

  it("measures a move only from when the watch was set up, though earlier candles are read", () => {
    const daily: PriceCondition = { market: "BTC", moves: "down", percent: 5, within: "24h" };
    const missed = [
      bar(0, 110, 110, 110, 110),
      bar(1, 100, 100, 100, 100),
      bar(2, 100, 100, 99, 99),
    ];
    expect(replay(daily, MINUTE_MS, false, missed, 2 * MINUTE_MS, MINUTE_MS).times).toBe(0);
    expect(replay(daily, 0, false, missed, 2 * MINUTE_MS, MINUTE_MS).times).toBe(1);
  });

  it("walks only from where it last looked, with earlier candles kept for a move's window", () => {
    const move: PriceCondition = { market: "BTC", moves: "down", percent: 5, within: "5m" };
    const missed = [bar(0, 100, 100, 99, 99), bar(1, 99, 99, 96, 97), bar(2, 97, 97, 94, 95)];
    const walked = replay(move, 0, false, missed, 2 * MINUTE_MS, MINUTE_MS);
    expect(walked).toEqual({ first: missed[2], times: 1, holds: true });
  });
});
