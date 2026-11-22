import { describe, expect, it } from "vitest";

import type { SourceBatch, SourceWatch } from "../contract.ts";
import type { PriceCondition } from "./condition.ts";
import type { Bar } from "./evaluate.ts";
import recordedCandles from "./fixtures/btc-1m-candles.json";
import recordedTicks from "./fixtures/allmids-ticks.json";
import type { MidStream, Tick } from "./hyperliquid.ts";
import { runPrices, type PriceFeed } from "./run.ts";

// Recorded from Hyperliquid's public API on 2026-11-05: four hours of BTC's 1m candles, as BTC
// slid from about $80,260 to $79,600, then the next allMids ticks for BTC, ETH and xyz:NVDA.

const candles: Bar[] = recordedCandles.map(({ t, o, h, l, c }) => ({
  t,
  o: Number(o),
  h: Number(h),
  l: Number(l),
  c: Number(c),
}));
const asleepAt = candles[0]!.t;
const wokeAt = candles.at(-1)!.t + 60_000;
const ticks: Tick[] = recordedTicks.map((message, index) => ({
  at: wokeAt + index * 500,
  mids: Object.fromEntries(Object.entries(message.data.mids).map(([k, v]) => [k, Number(v)])),
}));

/** Hyperliquid as recorded: BTC's candles, then the ticks, once each. */
function replayedFeed(): PriceFeed & { readonly dexes: Set<string> } {
  const dexes = new Set<string>();
  return {
    dexes,
    async candles(market, _interval, from, to) {
      return market === "BTC" ? candles.filter(({ t }) => t >= from && t <= to) : [];
    },
    openMids(): MidStream {
      return {
        subscribe: (dex) => void dexes.add(dex),
        async *ticks() {
          yield* ticks;
        },
      };
    },
  };
}

function watch(id: string, condition: PriceCondition, since = asleepAt - 3_600_000): SourceWatch {
  return { id, condition, ref: null, since: new Date(since) };
}

/** BTC's 1m candles drawn from a price at each moment, then the ticks given. */
function synthetic(price: (t: number) => number, live: readonly Tick[] = []): PriceFeed {
  return {
    async candles(_market, _interval, from, to) {
      const bars: Bar[] = [];
      for (let t = from - (from % 60_000); t <= to; t += 60_000) {
        const [open, close] = [price(t), price(t + 59_999)];
        bars.push({ t, o: open, h: Math.max(open, close), l: Math.min(open, close), c: close });
      }
      return bars;
    },
    openMids: () => ({
      subscribe() {},
      async *ticks() {
        yield* live;
      },
    }),
  };
}

async function run(
  watches: readonly SourceWatch[],
  saved: { cursor: string | null; since: Date | null },
  feed: PriceFeed = replayedFeed(),
  now = wokeAt,
): Promise<SourceBatch[]> {
  const batches: SourceBatch[] = [];
  for await (const batch of runPrices(
    {
      watches: () => watches,
      refresh: async () => watches,
      ...saved,
      signal: new AbortController().signal,
    },
    feed,
    () => now,
  ))
    batches.push(batch);
  return batches;
}

const firstKey = (id: string, condition: PriceCondition) => `${id}|${JSON.stringify(condition)}`;

describe("the prices source", () => {
  const under80k: PriceCondition = { market: "BTC", crosses: "below", price: 80_000 };

  it("fires once, late, for a level crossed while it slept, and not again on waking past it", async () => {
    const asleep = watch("asleep", under80k);
    // When it went to sleep, BTC was above $80,000.
    const cursor = JSON.stringify({ held: { [firstKey("asleep", under80k)]: false } });
    const batches = await run([asleep], { cursor, since: new Date(asleepAt) });

    const fires = batches.flatMap((batch) => batch.fires);
    expect(fires).toHaveLength(1);
    const [fire] = fires;
    const firstUnder = candles.find(({ l }) => l <= 80_000)!;
    expect(fire).toMatchObject({
      watchId: "asleep",
      id: `asleep:${firstUnder.t}`,
      at: new Date(firstUnder.t),
      late: true,
      report: {
        market: "BTC",
        condition: "BTC crosses below 80000",
        firstHappened: new Date(firstUnder.t).toISOString(),
        priceNow: candles.at(-1)!.c,
      },
    });
    expect((fire!.report as { timesWhileAway: number }).timesWhileAway).toBeGreaterThanOrEqual(1);
    // The cursor it leaves says the level holds now, so the next run won't tell it again.
    expect(JSON.parse(batches.at(-1)!.cursor)).toEqual({
      held: { [firstKey("asleep", under80k)]: true },
    });
  });

  it("fires on the tick a level is crossed, on each market's own dex", async () => {
    const btc: PriceCondition = { market: "BTC", crosses: "below", price: 79_600 };
    const eth: PriceCondition = { market: "ETH", crosses: "below", price: 2_386 };
    const far: PriceCondition = { market: "BTC", crosses: "above", price: 90_000 };
    const nvda: PriceCondition = { market: "xyz:NVDA", moves: "down", percent: 0.1, within: "5m" };
    const feed = replayedFeed();
    const batches = await run(
      [
        watch("btc", btc, wokeAt),
        watch("eth", eth, wokeAt),
        watch("far", far, wokeAt),
        watch("nvda", nvda, wokeAt),
      ],
      { cursor: null, since: null },
      feed,
    );

    const fires = batches.flatMap((batch) => batch.fires);
    const at = (market: string, price: number) =>
      ticks.find(({ mids }) => mids[market] === price)!.at;
    expect(fires.map(({ watchId, at, late }) => ({ watchId, at, late }))).toEqual([
      // xyz:NVDA 0.1% under the window's high of 196.885, and again each time it dips that far
      // after bouncing back; whether those wake anyone is the hub's (the watch's repeat).
      { watchId: "nvda", at: new Date(at("xyz:NVDA", 196.675)), late: undefined },
      { watchId: "nvda", at: new Date(at("xyz:NVDA", 196.64)), late: undefined },
      { watchId: "nvda", at: new Date(at("xyz:NVDA", 196.655)), late: undefined },
      // BTC and ETH cross on the same tick.
      { watchId: "btc", at: new Date(at("BTC", 79_587.5)), late: undefined },
      { watchId: "eth", at: new Date(at("ETH", 2_385.25)), late: undefined },
    ]);
    expect(fires.find(({ watchId }) => watchId === "btc")!.report).toEqual({
      market: "BTC",
      price: 79_587.5,
      condition: "BTC crosses below 79600",
    });
    expect([...feed.dexes].toSorted()).toEqual(["", "xyz"]);
  });

  it("hears a watch set up after it started with none, as a socket asked for nothing says nothing", async () => {
    const live: Tick[] = [80_100, 79_900].map((BTC, index) => ({
      at: wokeAt + index * 500,
      mids: { BTC },
    }));
    // Hyperliquid's socket as it behaves: silent, and so ended, unless something was asked for.
    let asked = false;
    const feed: PriceFeed = {
      candles: async () => [],
      openMids: () => ({
        subscribe: () => void (asked = true),
        async *ticks() {
          if (!asked) throw new Error("Hyperliquid's prices went quiet");
          yield* live;
        },
      }),
    };
    const later = watch("later", under80k, wokeAt);
    let reads = 0;
    const fires: string[] = [];
    for await (const batch of runPrices(
      {
        // None as the run starts; set up by its first tick.
        watches: () => (reads++ === 0 ? [] : [later]),
        refresh: async () => [later],
        cursor: null,
        since: null,
        signal: new AbortController().signal,
      },
      feed,
      () => wokeAt,
    ))
      fires.push(...batch.fires.map(({ watchId }) => watchId));
    expect(fires).toEqual(["later"]);
  });

  it("never counts a move made before the watch was set up, catching up after a reconnect", async () => {
    // BTC sat at 110 more than 20 hours before the watch was set up, and at 100 ever since.
    const setUp = Date.parse("2026-11-05T12:00:00Z");
    const feed = synthetic((t) => (t < setUp - 20 * 3_600_000 ? 110 : 100));
    const daily: PriceCondition = { market: "BTC", moves: "down", percent: 5, within: "24h" };
    // Live, it never held; the socket dropped two minutes in.
    const cursor = JSON.stringify({ held: { [firstKey("daily", daily)]: false } });
    const batches = await run(
      [watch("daily", daily, setUp)],
      { cursor, since: new Date(setUp + 2 * 60_000) },
      feed,
      setUp + 5 * 60_000,
    );
    expect(batches.flatMap((batch) => batch.fires)).toEqual([]);
  });

  it("tells a fire recorded live again under the same id when catching up, so it counts once", async () => {
    // BTC crosses below 100 half a minute in; the cursor was last saved ten seconds in, and the
    // run stopped after recording the fire, before saving its cursor.
    const t0 = Date.parse("2026-11-05T12:00:00Z");
    const price = (t: number) => (t < t0 + 30_000 ? 101 : 99);
    const level: PriceCondition = { market: "BTC", crosses: "below", price: 100 };
    const ticksFrom = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        at: t0 + i * 1_000,
        mids: { BTC: price(t0 + i * 1_000) },
      }));
    const live = await run(
      [watch("level", level, t0 - 3_600_000)],
      { cursor: null, since: null },
      synthetic(price, ticksFrom(60)),
      t0,
    );
    const told = live.flatMap((batch) => batch.fires);
    expect(told.map(({ id }) => id)).toEqual([`level:${t0}`]);

    const cursor = JSON.stringify({ held: { [firstKey("level", level)]: false } });
    const again = await run(
      [watch("level", level, t0 - 3_600_000)],
      { cursor, since: new Date(t0 + 10_000) },
      synthetic(price),
      t0 + 2 * 60_000,
    );
    expect(again.flatMap((batch) => batch.fires).map(({ id, late }) => ({ id, late }))).toEqual([
      { id: `level:${t0}`, late: true },
    ]);
  });

  it("starts a watch set up while it slept from when it was set up", async () => {
    // Set up half an hour before waking, when BTC was already under $80,000: not a crossing.
    const late = watch("set-late", under80k, wokeAt - 30 * 60_000);
    const batches = await run([late], {
      cursor: JSON.stringify({ held: {} }),
      since: new Date(asleepAt),
    });
    expect(batches.flatMap((batch) => batch.fires)).toEqual([]);
  });
});
