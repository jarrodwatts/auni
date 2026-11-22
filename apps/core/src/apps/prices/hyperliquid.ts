import type { Bar } from "./evaluate.ts";

// Hyperliquid's public market data, which needs no key: every market's mid price over its
// websocket (allMids, per dex), and candles over its info API for what a sleep missed.

const INFO_URL = "https://api.hyperliquid.xyz/info";
const WS_URL = "wss://api.hyperliquid.xyz/ws";
const TIMEOUT_MS = 10_000;
/** allMids sends several times a second; this long without one means the socket is gone. */
const SILENCE_MS = 60_000;

/** Hyperliquid's candle sizes, and the most of them it keeps: older candles are gone. */
export const INTERVALS = [
  ["1m", 60_000],
  ["5m", 300_000],
  ["15m", 900_000],
  ["1h", 3_600_000],
  ["4h", 14_400_000],
  ["1d", 86_400_000],
] as const;
const CANDLES_KEPT = 5_000;

/** The dex a market trades on: "" for Hyperliquid's own, "xyz" for "xyz:NVDA". */
export function dexOf(market: string): string {
  const colon = market.indexOf(":");
  return colon === -1 ? "" : market.slice(0, colon);
}

async function info(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok) throw new Error(`Hyperliquid answered ${response.status}`);
  return response.json();
}

function numbers(mids: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!mids || typeof mids !== "object") return out;
  for (const [market, price] of Object.entries(mids)) {
    const value = Number(price);
    if (Number.isFinite(value) && value > 0) out[market] = value;
  }
  return out;
}

/** Every market's mid price on one dex now. */
export async function mids(dex: string): Promise<Record<string, number>> {
  return numbers(await info({ type: "allMids", ...(dex ? { dex } : {}) }));
}

/** One market's day on Hyperliquid: "BTC", or "xyz:NVDA" on a dex of its own. */
export interface MarketDay {
  readonly market: string;
  readonly price: number;
  readonly dayAgo: number;
  /** Dollars traded in the last day. */
  readonly traded: number;
}

/** Every market listed on one dex, with its price now, a day ago, and what traded since. */
export async function marketDays(dex: string, signal: AbortSignal): Promise<MarketDay[]> {
  const answer = await info({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }, signal);
  if (!Array.isArray(answer)) return [];
  const [meta, contexts] = answer as [
    { universe?: readonly { name: string; isDelisted?: boolean }[] },
    readonly { markPx?: string; prevDayPx?: string; dayNtlVlm?: string }[],
  ];
  return (meta.universe ?? []).flatMap((listed, index) => {
    const context = contexts[index];
    const day = {
      market: listed.name,
      price: Number(context?.markPx),
      dayAgo: Number(context?.prevDayPx),
      traded: Number(context?.dayNtlVlm),
    };
    const readable = [day.price, day.dayAgo, day.traded].every(Number.isFinite) && day.dayAgo > 0;
    return listed.isDelisted || !readable ? [] : [day];
  });
}

/** The smallest candle that covers `from` to `to` within what Hyperliquid keeps. */
export function intervalFor(from: number, to: number): (typeof INTERVALS)[number] {
  return INTERVALS.find(([, ms]) => (to - from) / ms <= CANDLES_KEPT) ?? INTERVALS.at(-1)!;
}

/** One market's candles from `from` to `to`, oldest first, in the size given. */
export async function candles(
  market: string,
  interval: (typeof INTERVALS)[number][0],
  from: number,
  to: number,
): Promise<Bar[]> {
  const rows = await info({
    type: "candleSnapshot",
    req: { coin: market, interval, startTime: from, endTime: to },
  });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: Record<string, unknown>) => ({
      t: Number(row.t),
      o: Number(row.o),
      h: Number(row.h),
      l: Number(row.l),
      c: Number(row.c),
    }))
    .filter((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite))
    .toSorted((a, b) => a.t - b.t);
}

export interface Tick {
  readonly at: number;
  readonly mids: Readonly<Record<string, number>>;
}

/** An open allMids socket: ticks as they come, and more dexes subscribed as watches need them. */
export interface MidStream {
  subscribe(dex: string): void;
  ticks(): AsyncGenerator<Tick>;
}

/**
 * Opens Hyperliquid's websocket for mid prices. Its ticks end with a throw when the socket
 * closes, errors or goes silent (a laptop waking from sleep), so the run that reads it starts
 * again and catches up. `connect` is the WebSocket constructor, for tests.
 */
export function openMids(
  signal: AbortSignal,
  connect: (url: string) => WebSocket = (url) => new WebSocket(url),
): MidStream {
  const socket = connect(WS_URL);
  const subscribed = new Set<string>();
  const queue: Tick[] = [];
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let heardAt = Date.now();
  const notify = () => {
    wake?.();
    wake = null;
  };
  const fail = (error: Error) => {
    failure ??= error;
    notify();
  };
  const send = (dex: string) =>
    socket.send(
      JSON.stringify({
        method: "subscribe",
        subscription: { type: "allMids", ...(dex ? { dex } : {}) },
      }),
    );
  socket.addEventListener("open", () => {
    heardAt = Date.now();
    for (const dex of subscribed) send(dex);
  });
  socket.addEventListener("message", (message) => {
    heardAt = Date.now();
    let parsed: { channel?: unknown; data?: { mids?: unknown } };
    try {
      parsed = JSON.parse(String(message.data)) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.channel !== "allMids") return;
    queue.push({ at: heardAt, mids: numbers(parsed.data?.mids) });
    notify();
  });
  socket.addEventListener("close", () => fail(new Error("Hyperliquid's price socket closed")));
  socket.addEventListener("error", () => fail(new Error("Hyperliquid's price socket failed")));
  const silence = setInterval(() => {
    if (Date.now() - heardAt > SILENCE_MS) fail(new Error("Hyperliquid's prices went quiet"));
  }, SILENCE_MS / 4);
  const stop = () => fail(new Error("stopped"));
  signal.addEventListener("abort", stop, { once: true });

  return {
    subscribe(dex) {
      if (subscribed.has(dex)) return;
      subscribed.add(dex);
      if (socket.readyState === WebSocket.OPEN) send(dex);
    },
    async *ticks() {
      try {
        while (true) {
          const tick = queue.shift();
          if (tick) {
            yield tick;
            continue;
          }
          if (failure) {
            if (signal.aborted) return;
            throw failure;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        clearInterval(silence);
        signal.removeEventListener("abort", stop);
        socket.close();
      }
    },
  };
}
