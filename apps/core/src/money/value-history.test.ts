import { describe, expect, it, vi } from "vitest";

import type { PricePoint } from "./history.ts";
import { startOfDay, valueSeries, type Reading } from "./value-history.ts";

const T0 = Date.parse("2026-10-24T00:00:00Z");
const MINUTE = 60_000;
const at = (minutes: number) => T0 + minutes * MINUTE;

/** A price every 15 minutes from T0. */
const prices = (...values: number[]): PricePoint[] =>
  values.map((price, index) => ({ at: at(index * 15), price }));

const NVDA = "token:monad:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const BTC = "hyperliquid:BTC";

/** $40 of cash and one NVIDIA at $100, bought for $100 just before T0 and read at T0. */
const BOUGHT = { at: at(-1), usd: 100, key: "monad:0xc845b2894dbddd03858fd2d643b4ef725fe0849d" };
const reading = (fields: Partial<Reading> = {}): Reading => ({
  at: T0,
  usd: 140,
  cashUsd: 40,
  held: [{ key: NVDA, usd: 100, perp: null, from: null }],
  ...fields,
});

const series = (
  readings: readonly Reading[],
  minutes: readonly number[],
  paths: Record<string, PricePoint[]>,
  extra: Partial<Parameters<typeof valueSeries>[0]> = {},
) =>
  valueSeries({
    readings,
    times: minutes.map(at),
    paths: new Map(Object.entries(paths)),
    flows: [BOUGHT],
    ...extra,
  }).map(({ usdValue, madeUsd }) => [usdValue, madeUsd]);

describe("valueSeries", () => {
  it("moves each holding in proportion to its price", () => {
    expect(series([reading()], [0, 15, 30], { [NVDA]: prices(100, 104, 98.5) })).toEqual([
      ["140.00", "0.00"],
      ["144.00", "4.00"],
      ["138.50", "-1.50"],
    ]);
  });

  it("moves a holding from the price its reading valued it at, not the history point before", () => {
    // Read at 10 past at $110, when the last 15-minute point said $100.
    const late = reading({
      at: at(10),
      usd: 150,
      held: [{ key: NVDA, usd: 110, perp: null, from: 110 }],
    });
    expect(series([late], [10, 14, 15], { [NVDA]: prices(100, 110) }, { flows: [] })).toEqual([
      ["150.00", "110.00"],
      ["150.00", "110.00"],
      ["150.00", "110.00"],
    ]);
  });

  it("keeps a buy's fee at the buy rather than spreading it over the time before", () => {
    const cash = reading({ usd: 40, held: [] });
    const bought = reading({
      at: at(30),
      usd: 139.75,
      held: [{ key: NVDA, usd: 99.75, perp: null, from: 100 }],
    });
    const flows = [{ at: at(20), usd: 100 }];
    expect(
      series([cash, bought], [0, 15, 30], { [NVDA]: prices(100, 100, 100) }, { flows }).map(
        ([usd]) => usd,
      ),
    ).toEqual(["40.00", "40.00", "139.75"]);
  });

  it("gains on a short as its price falls", () => {
    const short = reading({
      usd: 90,
      held: [{ key: BTC, usd: 50, perp: { size: 0.002, short: true }, from: null }],
    });
    const flows = [{ at: at(-1), usd: 50 }];
    expect(series([short], [15], { [BTC]: prices(100_000, 95_000) }, { flows })).toEqual([
      ["100.00", "10.00"],
    ]);
  });

  it("never takes a perp below zero, as a position closed at its margin", () => {
    const long = reading({
      usd: 50,
      held: [{ key: BTC, usd: 10, perp: { size: 0.001, short: false }, from: null }],
    });
    const flows = [{ at: at(-1), usd: 10 }];
    expect(series([long], [15], { [BTC]: prices(100_000, 80_000) }, { flows })).toEqual([
      ["40.00", "-10.00"],
    ]);
  });

  it("holds flat what has no price history, and draws nothing before the first reading", () => {
    expect(series([reading({ at: at(15) })], [0, 15, 30], {})).toEqual([
      ["140.00", "0.00"],
      ["140.00", "0.00"],
    ]);
  });

  it("spreads a small gap to the next reading evenly across the interval", () => {
    // Prices said $140 an hour on; the venue read $140.80, under $1.40 (1%).
    const next = reading({ at: at(60), usd: 140.8 });
    expect(
      series([reading(), next], [0, 15, 30, 45, 60], { [NVDA]: prices(100, 100, 100, 100, 100) }),
    ).toEqual([
      ["140.00", "0.00"],
      ["140.20", "0.20"],
      ["140.40", "0.40"],
      ["140.60", "0.60"],
      ["140.80", "0.80"],
    ]);
  });

  it("leaves a bigger gap as a step where the reading lands, and tells of it", () => {
    const onGap = vi.fn();
    const next = reading({ at: at(60), usd: 150 });
    expect(
      series([reading(), next], [30, 60], { [NVDA]: prices(100, 100, 100, 100, 100) }, { onGap }),
    ).toEqual([
      ["140.00", "0.00"],
      ["150.00", "10.00"],
    ]);
    expect(onGap).toHaveBeenCalledOnce();
    expect(onGap).toHaveBeenCalledWith(next, 10);
  });

  it("spreads only what was made: a deposit steps in when it lands, and is never made", () => {
    const onGap = vi.fn();
    // $50 arrived as cash, and NVIDIA did 50 cents more than its feed said.
    const next = reading({ at: at(60), usd: 190.5, cashUsd: 90 });
    expect(
      series([reading(), next], [30, 60], { [NVDA]: prices(100, 100, 100, 100, 100) }, { onGap }),
    ).toEqual([
      ["140.25", "0.25"],
      ["190.50", "0.50"],
    ]);
    expect(onGap).not.toHaveBeenCalled();
  });

  it("counts a trade's money as put in, measured by what the reading held", () => {
    // $30 of cash became $30 of NVIDIA after T0, before the next reading at 60.
    const flows = [BOUGHT, { at: at(20), usd: 30 }];
    const next = reading({
      at: at(60),
      usd: 140,
      cashUsd: 10,
      held: [{ key: NVDA, usd: 130, perp: null, from: null }],
    });
    expect(
      series([reading(), next], [30, 60], { [NVDA]: prices(100, 100, 100, 100, 100) }, { flows }),
    ).toEqual([
      ["140.00", "0.00"],
      ["140.00", "0.00"],
    ]);
  });
  it("draws no loss where a holding's price stops, nor a gain where it comes back", () => {
    const onGap = vi.fn();
    // At 30 NVIDIA's feed gives no price: the reading leaves its $100 out of the value.
    const unpriced = reading({
      at: at(30),
      usd: 40,
      held: [],
      unpriced: new Set([BOUGHT.key]),
    });
    const back = reading({ at: at(60), usd: 141 });
    expect(
      series(
        [reading(), unpriced, back],
        [0, 30, 60],
        { [NVDA]: prices(100, 100, 100, 101) },
        {
          onGap,
        },
      ),
    ).toEqual([
      ["140.00", "0.00"],
      ["40.00", "0.00"],
      ["141.00", "1.00"],
    ]);
    expect(onGap).not.toHaveBeenCalled();
  });
});

describe("startOfDay", () => {
  it("is the person's own midnight", () => {
    expect(new Date(startOfDay("Australia/Sydney", Date.parse("2026-10-24T05:00:00Z")))).toEqual(
      new Date("2026-10-23T13:00:00Z"),
    );
    expect(new Date(startOfDay("UTC", Date.parse("2026-10-24T23:59:59.999Z")))).toEqual(
      new Date("2026-10-24T00:00:00Z"),
    );
  });

  it("keeps the midnight's own offset when the clocks change later that day", () => {
    // New York leaves daylight saving at 2am on 1 November 2026: midnight was still EDT.
    expect(new Date(startOfDay("America/New_York", Date.parse("2026-11-01T20:00:00Z")))).toEqual(
      new Date("2026-11-01T04:00:00Z"),
    );
    // Sydney starts it at 2am on 4 October 2026: midnight was still AEST.
    expect(new Date(startOfDay("Australia/Sydney", Date.parse("2026-10-04T05:00:00Z")))).toEqual(
      new Date("2026-10-03T14:00:00Z"),
    );
  });
});
