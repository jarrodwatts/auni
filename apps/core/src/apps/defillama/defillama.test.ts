import { afterEach, describe, expect, it, vi } from "vitest";

import { day, history, prices } from "./defillama.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function answering(body: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json(body);
    }),
  );
  return urls;
}

describe("DefiLlama", () => {
  it("reads prices now, or near a moment within four hours", async () => {
    const urls = answering({ coins: { "coingecko:solana": { price: 150 } } });
    expect([...(await prices(["coingecko:solana", "monad:0xabc"]))]).toEqual([
      ["coingecko:solana", { price: 150 }],
    ]);
    await prices(["coingecko:solana"], new Date(1_700_000_000_500));
    expect(urls).toEqual([
      "https://coins.llama.fi/prices/current/coingecko:solana,monad:0xabc",
      "https://coins.llama.fi/prices/historical/1700000000/coingecko:solana?searchWidth=4h",
    ]);
  });

  // The calls core made before the feed was an app: the portfolio's two days by the quarter
  // hour and week by the hour, a card's week by two hours, a pick's quarter by the day.
  it("reads a chart from a moment to now in milliseconds, a point each step", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_900 + 2 * 24 * 60 * 60_000, toFake: ["Date"] });
    const urls = answering({
      coins: { "coingecko:solana": { prices: [{ timestamp: 1_700_000_000, price: 150 }] } },
    });
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    expect(await history("coingecko:solana", "15m", now - 2 * day)).toEqual([
      { at: 1_700_000_000_000, price: 150 },
    ]);
    await history("coingecko:solana", "1h", now - 8 * day);
    await history("coingecko:solana", "2h", now - 7 * day - 200_000);
    await history("coingecko:solana", "1d", now - 90 * day);
    expect(urls.map((url) => url.replace(/start=\d+&/u, ""))).toEqual([
      "https://coins.llama.fi/chart/coingecko:solana?span=193&period=15m&searchWidth=1h",
      "https://coins.llama.fi/chart/coingecko:solana?span=193&period=1h&searchWidth=1h",
      "https://coins.llama.fi/chart/coingecko:solana?span=85&period=2h",
      "https://coins.llama.fi/chart/coingecko:solana?span=91&period=1d",
    ]);
    expect(urls[0]).toContain("?start=1700000000&");
  });

  it("keeps no history of a chain it doesn't name, and asks for none", async () => {
    const urls = answering({ coins: {} });
    expect(await history(`eip155:43114:0x${"2".repeat(40)}`, "1h", 0)).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("reads a coin's price now with its change over the day", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return Response.json({
          coins: url.includes("/percentage/")
            ? { "coingecko:monad": -2.5 }
            : { "coingecko:monad": { price: 3 } },
        });
      }),
    );
    expect(await day("coingecko:monad")).toEqual({ price: 3, today: -2.5 });
    expect(urls.toSorted()).toEqual([
      "https://coins.llama.fi/percentage/coingecko:monad?period=24h",
      "https://coins.llama.fi/prices/current/coingecko:monad",
    ]);
  });
});
