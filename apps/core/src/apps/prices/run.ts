import type { SourceBatch, SourceFire, SourceRun, SourceWatch } from "../contract.ts";
import { describe, priceConditionSchema, type PriceCondition } from "./condition.ts";
import { keepMs, MINUTE_MS, observe, replay, step, type Bar } from "./evaluate.ts";
import {
  candles as hyperliquidCandles,
  dexOf,
  intervalFor,
  openMids,
  type MidStream,
} from "./hyperliquid.ts";

// Watches prices on this machine: every watch's condition is checked against each tick of
// Hyperliquid's mid prices. The cursor keeps whether each watch's condition held, so after a sleep
// the candles missed are walked from where it stood, and something that happened meanwhile fires
// once, late.
//
// A fire's id is its watch and the minute it happened, whether seen on a tick or read from a
// minute candle, so a fire recorded live and told again from the candles after a restart (the
// cursor is saved only after recording) counts once. A watch fires at most once a minute.

/** A batch with no fires marks progress at most this often, so a catch-up starts near now. */
const CHECKPOINT_MS = 60_000;

/** Whether each watch's condition held, by watch and condition: an edited one starts afresh. */
type Held = Record<string, boolean>;

interface Watched {
  readonly watch: SourceWatch;
  readonly condition: PriceCondition;
  readonly key: string;
}

function watched(watches: readonly SourceWatch[]): Watched[] {
  return watches.flatMap((watch) => {
    const parsed = priceConditionSchema.safeParse(watch.condition);
    if (!parsed.success) return [];
    return [{ watch, condition: parsed.data, key: `${watch.id}|${JSON.stringify(parsed.data)}` }];
  });
}

function readCursor(cursor: string | null): Held {
  try {
    const parsed: unknown = cursor ? JSON.parse(cursor) : {};
    return parsed && typeof parsed === "object" ? ((parsed as { held?: Held }).held ?? {}) : {};
  } catch {
    return {};
  }
}

/** The cursor: what held, for the watches still watched. */
function cursorOf(held: Held, current: readonly Watched[]): string {
  const kept = Object.fromEntries(
    current.flatMap(({ key }) => (key in held ? [[key, held[key]!]] : [])),
  );
  return JSON.stringify({ held: kept });
}

export interface PriceFeed {
  readonly candles: typeof hyperliquidCandles;
  openMids(signal: AbortSignal): MidStream;
}

const hyperliquid: PriceFeed = { candles: hyperliquidCandles, openMids };

/**
 * The prices source's run: catches up on the candles since `since` for each watch, then checks
 * every tick. `feed` is Hyperliquid's unless a test replays its own.
 */
export async function* runPrices(
  context: SourceRun,
  feed: PriceFeed = hyperliquid,
  now: () => number = Date.now,
): AsyncGenerator<SourceBatch> {
  const held = readCursor(context.cursor);
  // Opened first, so no tick between the catch-up and the stream goes unseen.
  const stream = feed.openMids(context.signal);
  const bars = new Map<string, Bar[]>();
  const start = now();

  // The main dex is listened to whatever is watched. A watch set up later is noticed on a tick,
  // and a socket asked for nothing says nothing, until its silence ends the run a minute on.
  stream.subscribe("");
  const first = watched(context.watches());
  for (const dex of new Set(first.map(({ condition }) => dexOf(condition.market))))
    stream.subscribe(dex);
  const late = await catchUp(first, held, bars, context.since, start, feed);
  yield { fires: late, cursor: cursorOf(held, first) };

  let checkpointAt = now();
  for await (const tick of stream.ticks()) {
    const current = watched(context.watches());
    const keep = new Map<string, number>();
    for (const { condition } of current) {
      stream.subscribe(dexOf(condition.market));
      keep.set(condition.market, Math.max(keep.get(condition.market) ?? 0, keepMs([condition])));
    }
    for (const [market, price] of Object.entries(tick.mids)) {
      const kept = keep.get(market);
      if (kept === undefined) continue;
      const marketBars = bars.get(market) ?? [];
      observe(marketBars, tick.at, price, kept);
      bars.set(market, marketBars);
    }
    const fires: SourceFire[] = [];
    for (const { watch, condition, key } of current) {
      const price = tick.mids[condition.market];
      const since = watch.since.getTime();
      if (price === undefined || tick.at < since) continue;
      const marketBars = bars.get(condition.market) ?? [];
      const result = step(condition, since, held[key], price, marketBars, tick.at);
      held[key] = result.holds;
      if (result.fires)
        fires.push({
          watchId: watch.id,
          id: `${watch.id}:${tick.at - (tick.at % MINUTE_MS)}`,
          at: new Date(tick.at),
          report: { market: condition.market, price, condition: describe(condition) },
        });
    }
    if (fires.length > 0 || tick.at - checkpointAt >= CHECKPOINT_MS) {
      checkpointAt = tick.at;
      yield { fires, cursor: cursorOf(held, current) };
    }
    if (context.signal.aborted) return;
  }
}

/**
 * Walks each market's candles since Auni last looked, for each watch: one late fire for a watch
 * whose condition came to hold meanwhile (saying when first and how often), and where each stands
 * now. Minute bars for the windows of move watches are kept for the ticks that follow.
 */
async function catchUp(
  watches: readonly Watched[],
  held: Held,
  bars: Map<string, Bar[]>,
  since: Date | null,
  now: number,
  feed: PriceFeed,
): Promise<SourceFire[]> {
  const fires: SourceFire[] = [];
  const byMarket = Map.groupBy(watches, ({ condition }) => condition.market);
  for (const [market, list] of byMarket) {
    const keep = keepMs(list.map(({ condition }) => condition));
    // The windows' minute bars, for the live ticks.
    if (keep > 0) bars.set(market, await feed.candles(market, "1m", now - keep - MINUTE_MS, now));
    if (!since) continue;
    const from = since.getTime();
    const [interval, barMs] = intervalFor(from - keep, now);
    const missed = await feed.candles(market, interval, from - keep, now);
    for (const { watch, condition, key } of list) {
      // From the candle that was open when the cursor was saved, so a fire told live in it is
      // told again under the same id; but only candles opened since the watch was set up.
      const since = watch.since.getTime();
      const walkFrom = Math.max(from - (from % barMs), since);
      const walked = replay(condition, since, held[key], missed, walkFrom, barMs);
      if (walked.holds !== undefined) held[key] = walked.holds;
      if (!walked.first) continue;
      const last = missed.at(-1)!;
      fires.push({
        watchId: watch.id,
        id: `${watch.id}:${walked.first.t}`,
        at: new Date(walked.first.t),
        late: true,
        report: {
          market,
          condition: describe(condition),
          firstHappened: new Date(walked.first.t).toISOString(),
          timesWhileAway: walked.times,
          priceNow: last.c,
          readFrom: `${interval} candles`,
        },
      });
    }
  }
  return fires;
}
