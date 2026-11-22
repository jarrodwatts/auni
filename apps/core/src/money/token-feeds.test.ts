import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tokens } from "../apps/contract.ts";
import { feedDay, feedHistory, feedListing, feedLogo, feedPrices } from "./token-feeds.ts";

// The feeds as the registry hands them over, first asked first (apps.test.ts holds that order
// to apps/order.ts). Here: who is believed, and what a feed that can't be read costs. The
// registry stands in whole: token-feeds.ts asks it for nothing but `filling`, and loading the
// real one (every app) inside the first test ran past its 5 seconds on a busy machine.
const feeds: Tokens[] = [];
vi.mock(import("../apps/registry.ts"), () => ({
  filling: ((role: string) =>
    role === "tokens"
      ? feeds.map((part) => ({ about: { id: "feed", name: "Feed" }, part }))
      : []) as never,
}));

const priced = (prices: Record<string, number>) =>
  vi.fn(
    async (ids: readonly string[], _at?: Date) =>
      new Map(ids.flatMap((id) => (id in prices ? [[id, { price: prices[id]! }] as const] : []))),
  );
const down = () =>
  vi.fn(async () => {
    throw new Error("down");
  });
const settled = async (asked: Map<string, Promise<unknown>>) =>
  Object.fromEntries(
    await Promise.all(
      [...asked].map(async ([id, price]) => [id, await price.catch(() => "unread")] as const),
    ),
  );

beforeEach(() => {
  feeds.length = 0;
});

describe("the token feeds", () => {
  it("believe the first feed that prices a token, and ask a later one only for what is left", async () => {
    const first = priced({ a: 1, b: 2 });
    const second = priced({ b: 20, c: 30 });
    feeds.push({ prices: first }, { logo: async () => null }, { prices: second });
    expect(await settled(feedPrices(["a", "b", "c", "d"]))).toEqual({
      a: { price: 1 },
      b: { price: 2 },
      c: { price: 30 },
      d: undefined,
    });
    expect(first.mock.calls).toEqual([[["a", "b", "c", "d"], undefined]]);
    expect(second.mock.calls).toEqual([
      [["c"], undefined],
      [["d"], undefined],
    ]);
  });

  it("ask the first feed for a hundred at a call, and each for the moment asked of", async () => {
    const first = priced({});
    feeds.push({ prices: first });
    const ids = Array.from({ length: 250 }, (_, index) => `id${index}`);
    const at = new Date(1_700_000_000_000);
    await settled(feedPrices(ids, at));
    expect(first.mock.calls.map(([batch, when]) => [batch.length, when])).toEqual([
      [100, at],
      [100, at],
      [50, at],
    ]);
  });

  it("take a later feed's price while an earlier one can't be read, and don't guess without one", async () => {
    feeds.push({ prices: down() }, { prices: priced({ a: 5 }) });
    expect(await settled(feedPrices(["a", "b"]))).toEqual({ a: { price: 5 }, b: "unread" });
    // A feed that has no price is an answer; only one that couldn't say leaves it unread.
    feeds.splice(0, 2, { prices: priced({}) }, { prices: down() });
    expect(await settled(feedPrices(["a"]))).toEqual({ a: "unread" });
  });

  it("answer a chart, a day, a listing and a picture from the first feed that has one", async () => {
    const usdc = { address: "0x1", symbol: "USDC", name: "USD Coin", decimals: 6, usdPrice: 1 };
    feeds.push(
      {
        history: async () => [],
        day: async () => ({}),
        listing: async () => null,
        logo: async () => "http://plain.example/a.png",
      },
      {
        listing: async () => null,
        // An https picture on a host the web's image server doesn't fetch from draws as initials.
        logo: async () => "https://art.example/a.png",
      },
      {
        history: async () => [{ at: 1, price: 2 }],
        day: async () => ({ price: 3, today: -1 }),
        listing: async () => usdc,
        logo: async () => "https://assets.coingecko.com/coins/images/1/a.png",
      },
    );
    expect(await feedHistory("a", "1h", 0)).toEqual([{ at: 1, price: 2 }]);
    expect(await feedDay("a")).toEqual({ price: 3, today: -1 });
    expect(await feedListing("base", "0x1")).toEqual(usdc);
    // A picture the web couldn't draw is passed over, so a later feed's is drawn instead.
    expect(await feedLogo("base", "0x1")).toBe("https://assets.coingecko.com/coins/images/1/a.png");
  });

  it("say nothing is known when no feed has it, throw when one couldn't say, and never for a picture", async () => {
    expect(await feedHistory("a", "1h", 0)).toEqual([]);
    expect(await feedDay("a")).toEqual({});
    expect(await feedListing("base", "0x1")).toBeNull();
    feeds.push({ history: down(), day: down(), listing: down(), logo: down() });
    await expect(feedHistory("a", "1h", 0)).rejects.toThrow("down");
    await expect(feedDay("a")).rejects.toThrow("down");
    await expect(feedListing("base", "0x1")).rejects.toThrow("down");
    expect(await feedLogo("base", "0x1")).toBeNull();
  });
});
