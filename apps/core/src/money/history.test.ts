import { afterEach, describe, expect, it, vi } from "vitest";

import { downFeed, tableFeed, useFeeds } from "../test/feeds.ts";
import { priceAt, pricePaths, pricesAt, tokenPrices } from "./history.ts";
import { within } from "./swaps/shared.ts";

vi.mock(import("../apps/index.generated.ts"), async (original) =>
  (await import("../test/feeds.ts")).withFeeds(await original()),
);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const HOUR = 60 * 60_000;

/**
 * A feed prices `coin` at $1 an hour ago and $2 now; Polymarket's history of any outcome
 * answers at once, and its live midpoint never does.
 */
function stubSources(coin: string, startedAt: number, after: readonly number[] = []) {
  const history = [startedAt - HOUR, ...after].map((at) => ({ at, price: 1 }));
  useFeeds({
    ...tableFeed({ [coin]: 2 }),
    history: async (id) => (id === coin ? history : []),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/prices-history")) return Response.json({ history: [] });
      return new Promise<Response>(() => {});
    }),
  );
}

describe("pricePaths", () => {
  it("ends each path in its live price at the caller's now, however long the read took", async () => {
    const coin = "coingecko:path-ends-now";
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    stubSources(coin, now);
    const paths = pricePaths([`token:${coin}`], "15m", now);
    // The read takes a moment; the line's last point is still `now`.
    vi.setSystemTime(now + 5_000);
    const path = await paths.get(`token:${coin}`)!;
    expect(priceAt(path, now)).toBe(2);
  });

  it("ends in the live price though its history was read later than the caller's now", async () => {
    const coin = "coingecko:read-late";
    const now = Date.now();
    // A cold read finishes after `now` and stamps its last point, the still-open step, then.
    stubSources(coin, now, [now + 3_000]);
    const path = await pricePaths([`token:${coin}`], "15m", now).get(`token:${coin}`)!;
    expect(path.map((point) => point.at)).toEqual([now - HOUR, now]);
    expect(priceAt(path, now)).toBe(2);
  });

  it("never holds a token's path waiting on a slow outcome's live price", async () => {
    const coin = "coingecko:not-held-up";
    const now = Date.now();
    stubSources(coin, now);
    const paths = pricePaths([`token:${coin}`, "polymarket:12345"], "15m", now);
    const path = await within(paths.get(`token:${coin}`)!, 1_000);
    expect(path.at(-1)?.price).toBe(2);
  });
});

describe("pricesAt", () => {
  it("prices a coin no feed has a price for near then at its price now, as the portfolio does", async () => {
    const [old, unpriced] = ["base:0xold-and-thin", "base:0xspam"];
    // Nothing near the moment it moved; only `old` has a price now.
    const now = tableFeed({ [old]: 3 });
    useFeeds({ prices: async (ids, at) => (at ? new Map() : now.prices!(ids)) });
    const prices = await pricesAt(
      [`token:${old}`, `token:${unpriced}`],
      new Date(Date.now() - 90 * 24 * HOUR),
    );
    expect([...prices]).toEqual([[`token:${old}`, 3]]);
  });
});

describe("tokenPrices", () => {
  it("asks about a token no feed prices once, and leaves it unpriced", async () => {
    const spam = "eip155:43114:0x2222222222222222222222222222222222222222";
    const asked: string[] = [];
    useFeeds(tableFeed({}), tableFeed({}, asked));
    const reads = [await tokenPrices([spam]), await tokenPrices([spam])];
    for (const { prices, complete } of reads) {
      expect(complete).toBe(true);
      expect(prices.size).toBe(0);
    }
    expect(asked).toEqual([spam]);
  });

  it("prices a token the first feed has no price for by a later one, and asks it only about that one", async () => {
    const [stock, listed] = ["monad:0x8C0D", "monad:0x3333"];
    const asked: string[] = [];
    useFeeds(tableFeed({ [listed]: 2 }), tableFeed({ [stock]: 900.1, [listed]: 1 }, asked));
    const { prices, complete } = await tokenPrices([stock, listed]);
    expect(complete).toBe(true);
    expect(prices.get(stock)?.price).toBe(900.1);
    expect(prices.get(listed)?.price).toBe(2);
    expect(asked).toEqual([stock]);
  });

  it("still prices a token by a later feed while the first can't be read", async () => {
    const stock = "monad:0x4444";
    useFeeds(downFeed, tableFeed({ [stock]: 12.5 }));
    const { prices, complete } = await tokenPrices([stock]);
    expect(prices.get(stock)?.price).toBe(12.5);
    expect(complete).toBe(true);
  });

  it("is incomplete when no feed priced a token and one of them couldn't be read", async () => {
    const stock = "monad:0x5555";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useFeeds(tableFeed({}), downFeed);
    const { prices, complete } = await tokenPrices([stock]);
    expect(prices.size).toBe(0);
    expect(complete).toBe(false);
  });
});
