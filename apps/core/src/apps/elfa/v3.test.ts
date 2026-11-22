import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import entities from "./fixtures/hype-entities.json";
import mindshareFixture from "./fixtures/crypto-mindshare.json";
import week from "./fixtures/hype-events-7d.json";
import {
  daysAgo,
  eventsById,
  findEvents,
  mindshare,
  oncePerStory,
  resolveEntity,
  storyFacts,
  type ElfaEvent,
} from "./v3.ts";

const HYPE = "944dcaf0-1b0a-44aa-bffc-11c1a80e1839";

const requests: { readonly url: URL; readonly key: string | null }[] = [];

/** Answers every fetch from `route`, keeping what was asked. */
function answer(route: (url: URL) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      requests.push({ url, key: new Headers(init?.headers).get("x-elfa-api-key") });
      const body = route(url);
      return body instanceof Response ? body : Response.json(body);
    }),
  );
}

beforeEach(() => {
  process.env.ELFA_AUTO_API_KEY = "elfa-test";
  requests.length = 0;
});
afterEach(() => {
  delete process.env.ELFA_AUTO_API_KEY;
  vi.unstubAllGlobals();
});

describe("Elfa's data API", () => {
  it("resolves an asset with Auni's key, once a day", async () => {
    answer(() => entities);
    const first = await resolveEntity("HYPE", ["token", "equity"]);
    const again = await resolveEntity("HYPE", ["token", "equity"]);

    expect(first).toMatchObject({
      id: HYPE,
      name: "Hyperliquid",
      externalIds: { coingeckoId: "hyperliquid" },
    });
    expect(again).toEqual(first);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toBe("elfa-test");
    expect(requests[0]?.url.pathname).toBe("/v3/entities");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      q: "HYPE",
      entityType: "token,equity",
      limit: "1",
    });
  });

  it("drops an entry Elfa changed the shape of, not the whole answer", async () => {
    answer(() => ({ ...week, events: [...week.events, { id: "odd" }] }));
    const events = await findEvents({ entityIds: HYPE, from: 1_791_550_800, limit: 30 });

    expect(events).toHaveLength(week.events.length);
    expect(requests[0]?.url.searchParams.get("from")).toBe("1791550800");
  });

  it("reads a story for the agent with its links and the price's move in percent", async () => {
    answer(() => week);
    const [newest] = await eventsById([week.events[0]!.id]);

    expect(requests[0]?.url.searchParams.get("eventIds")).toBe(week.events[0]!.id);
    expect(storyFacts(newest!)).toEqual({
      id: newest!.id,
      title: "Hyperliquid Strategies adds about 5.1 million HYPE in 29 days",
      summary: expect.stringContaining("38.7 million HYPE"),
      about: ["HYPE"],
      implication: "bullish",
      eventType: "marketFlow",
      at: "2026-10-16T12:10:54.000Z",
      sourceCount: 2,
      sources: [
        "https://x.com/Havochl_/status/2111004930727186591",
        "https://x.com/HypedLaunches/status/2111017900718846129",
      ],
      priceReaction: [{ symbol: "HYPE", dayChangePct: 0.89 }],
    });
  });

  it("ranks attention with its hot flags", async () => {
    answer(() => mindshareFixture);
    const ranked = await mindshare({ market: "crypto", period: "24h", limit: 5 });

    expect(requests[0]?.url.pathname).toBe("/v3/market/crypto/mindshare");
    expect(ranked[0]).toMatchObject({ rank: 1, symbol: "BTC", hot: false });
  });

  it("says when Elfa is busy, and asks nothing without a key", async () => {
    answer(() => new Response("{}", { status: 429 }));
    await expect(eventsById(["busy"])).rejects.toThrow("Elfa is busy right now");

    delete process.env.ELFA_AUTO_API_KEY;
    await expect(eventsById(["unset"])).rejects.toThrow("Elfa is not configured.");
    expect(requests).toHaveLength(1);
  });

  it("holds the agent's reads to 40 a minute, but never a fired watch's story", async () => {
    // A minute past the reads the tests above spent.
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ["Date"] });
    answer(() => week);
    for (let from = 0; from < 40; from += 1) await findEvents({ q: "budget", from });
    await expect(findEvents({ q: "budget", from: 40 })).rejects.toThrow("Elfa is busy right now");
    expect(requests).toHaveLength(40);
    await eventsById([week.events[0]!.id]);
    expect(requests).toHaveLength(41);

    vi.advanceTimersByTime(60_000);
    await findEvents({ q: "budget", from: 40 });
    expect(requests).toHaveLength(42);
    vi.useRealTimers();
  });
});

describe("daysAgo", () => {
  it("starts a range on a five-minute step, in seconds", () => {
    const now = Date.UTC(2026, 9, 17, 12, 34, 56);
    expect(daysAgo(7, now)).toBe(Date.UTC(2026, 9, 10, 12, 30) / 1_000);
  });
});

describe("oncePerStory", () => {
  const event = (id: string, storylineId: string | null) => ({ id, storylineId }) as ElfaEvent;

  it("keeps the first report of each story, and every event in none", () => {
    const kept = oncePerStory([
      event("a1", "a"),
      event("b1", "b"),
      event("a2", "a"),
      event("x", null),
      event("y", null),
    ]);
    expect(kept.map(({ id }) => id)).toEqual(["a1", "b1", "x", "y"]);
  });
});
