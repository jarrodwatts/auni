import { afterEach, describe, expect, it, vi } from "vitest";

import { polymarketPrices } from "./prices.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("polymarketPrices.history", () => {
  it("reads a pick's 90 days with a start and no end, as Polymarket refuses a long span", async () => {
    // With endTs, clob.polymarket.com answers 400 "'startTs' and 'endTs' interval is too long"
    // for any span over about 15 days (checked live on 2026-11-06).
    const fetch = vi.fn(async (_url: string) =>
      Response.json({ history: [{ t: 1_700_000_000, p: 0.42 }] }),
    );
    vi.stubGlobal("fetch", fetch);
    const from = Date.now() - 90 * 86_400_000;

    const points = await polymarketPrices.history("123", "1d", from);

    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe("/prices-history");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      market: "123",
      startTs: String(Math.floor(from / 1_000)),
      fidelity: "1440",
    });
    expect(points).toEqual([{ at: 1_700_000_000_000, price: 0.42 }]);
  });
});
