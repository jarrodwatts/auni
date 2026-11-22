import { WINDOWS, type PriceCondition } from "./condition.ts";

// A condition is a state that holds or doesn't at each price; a watch fires on the moment it comes
// to hold, after not holding. A watch first seen holding (a level already past) waits until it
// stops and comes again. Live, the price is each tick; asleep, it is the candles read on waking.
// A move's window never reaches back before the watch was set up (`since`, to the bar), so live
// and catching up judge the same prices, and a move made before it never counts.

/** A candle: its start (ms) and open, high, low and close. Live, Auni keeps minute bars. */
export interface Bar {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

export const MINUTE_MS = 60_000;

function windowMs(condition: PriceCondition): number {
  return "within" in condition ? WINDOWS[condition.within] * MINUTE_MS : 0;
}

/** How far back a market's bars are needed for its watches' windows. */
export function keepMs(conditions: readonly PriceCondition[]): number {
  return Math.max(0, ...conditions.map(windowMs));
}

/** Takes one price into a market's minute bars, dropping bars older than any window needs. */
export function observe(bars: Bar[], at: number, price: number, keep: number): void {
  const t = at - (at % MINUTE_MS);
  const last = bars.at(-1);
  if (last && last.t === t) {
    bars[bars.length - 1] = {
      ...last,
      h: Math.max(last.h, price),
      l: Math.min(last.l, price),
      c: price,
    };
  } else if (!last || last.t < t) {
    bars.push({ t, o: price, h: price, l: price, c: price });
  }
  const oldest = at - keep - MINUTE_MS;
  while (bars.length > 1 && bars[0]!.t < oldest) bars.shift();
}

/**
 * The low and high of the bars (each `barMs` long) inside a window ending at `at` and starting no
 * earlier than `since`, and `price`.
 */
function range(
  bars: readonly Bar[],
  at: number,
  width: number,
  since: number,
  price: number,
  barMs: number,
) {
  const start = Math.max(at - width, since);
  let low = price;
  let high = price;
  for (const bar of bars) {
    if (bar.t > at || bar.t + barMs <= start) continue;
    low = Math.min(low, bar.l);
    high = Math.max(high, bar.h);
  }
  return { low, high };
}

/**
 * Whether the condition, set up at `since`, holds at this price, at `at`, with the market's bars
 * up to then.
 */
function holds(
  condition: PriceCondition,
  since: number,
  price: number,
  bars: readonly Bar[],
  at: number,
  barMs = MINUTE_MS,
): boolean {
  if ("crosses" in condition)
    return condition.crosses === "above" ? price >= condition.price : price <= condition.price;
  const { low, high } = range(bars, at, windowMs(condition), since, price, barMs);
  const up = ((price - low) / low) * 100 >= condition.percent;
  const down = ((high - price) / high) * 100 >= condition.percent;
  return condition.moves === "up" ? up : condition.moves === "down" ? down : up || down;
}

/** A tick: whether the watch fires now, and whether it holds, for the next. */
export function step(
  condition: PriceCondition,
  since: number,
  held: boolean | undefined,
  price: number,
  bars: readonly Bar[],
  at: number,
): { readonly fires: boolean; readonly holds: boolean } {
  const now = holds(condition, since, price, bars, at);
  return { fires: held === false && now, holds: now };
}

/**
 * Walks the candles a sleep missed, from `from` on: when the condition first came to hold, how
 * many times it did, and whether it holds at the end. A candle shows only its range, so a level
 * it straddles was crossed whichever way the price went, and one it left and came back to was
 * crossed again inside it. `bars` (each `barMs` long, oldest first) may start before `from`, for a
 * move's window, which still starts no earlier than `since`, when the watch was set up.
 */
export function replay(
  condition: PriceCondition,
  since: number,
  held: boolean | undefined,
  bars: readonly Bar[],
  from: number,
  barMs: number,
): { readonly first: Bar | null; readonly times: number; readonly holds: boolean | undefined } {
  let first: Bar | null = null;
  let times = 0;
  let state = held;
  const width = windowMs(condition);
  for (const bar of bars) {
    if (bar.t < from) continue;
    // As it stood when the candle opened, for a watch first seen now.
    state ??= holds(condition, since, bar.o, bars, bar.t - 1, barMs);
    let came: boolean;
    if ("crosses" in condition) {
      const level = condition.price;
      const above = condition.crosses === "above";
      const reached = above ? bar.h >= level : bar.l <= level;
      const left = above ? bar.l < level : bar.h > level;
      const ended = above ? bar.c >= level : bar.c <= level;
      came = (!state && reached) || (state && left && ended);
      state = ended;
    } else {
      // At its furthest from the window's other end, inside this candle.
      const { low, high } = range(bars, bar.t, width, since, bar.c, barMs);
      const up = ((bar.h - low) / low) * 100 >= condition.percent;
      const down = ((high - bar.l) / high) * 100 >= condition.percent;
      const reached =
        condition.moves === "up" ? up : condition.moves === "down" ? down : up || down;
      came = !state && reached;
      state = holds(condition, since, bar.c, bars, bar.t + barMs - 1, barMs);
    }
    if (came) {
      first ??= bar;
      times += 1;
    }
  }
  return { first, times, holds: state };
}
