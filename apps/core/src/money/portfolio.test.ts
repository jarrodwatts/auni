import { afterEach, describe, expect, it, vi } from "vitest";

import { downFeed, tableFeed, useFeeds } from "../test/feeds.ts";
import { priceHoldings } from "./portfolio.ts";

vi.mock(import("../apps/index.generated.ts"), async (original) =>
  (await import("../test/feeds.ts")).withFeeds(await original()),
);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A token in the wallet, priced by its price id. */
function token(address: string): Parameters<typeof priceHoldings>[0][number] {
  return {
    venue: "wallet",
    chain: "eip155:4326",
    instrument: address,
    symbol: "TKN",
    decimals: 18,
    cash: false,
    priceId: `eip155:4326:${address}`,
    baseUnits: 10n ** 18n,
  };
}

const SOL: Parameters<typeof priceHoldings>[0][number] = {
  venue: "wallet",
  chain: "solana",
  instrument: "native",
  symbol: "SOL",
  decimals: 9,
  cash: false,
  priceId: "coingecko:solana",
  baseUnits: 10n ** 9n,
};

describe("priceHoldings", () => {
  it("counts a price no feed could be read for as prices unread, not as a holding worth nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useFeeds(tableFeed({}), downFeed);
    const { holdings, pricesRead } = await priceHoldings([
      token("0x0000000000000000000000000000000000000001"),
    ]);
    expect(holdings[0]?.usdValue).toBeNull();
    expect(pricesRead).toBe(false);
  });

  it("keeps the prices that were read when a feed can't be read for another token", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useFeeds(tableFeed({ [SOL.priceId!]: 100 }), downFeed);
    const { holdings, pricesRead } = await priceHoldings([
      token("0x0000000000000000000000000000000000000004"),
      SOL,
    ]);
    expect(holdings.map((holding) => holding.usdValue)).toEqual([null, "100.00"]);
    expect(pricesRead).toBe(false);
  });

  it("leaves a token no feed prices unpriced, and the read whole", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useFeeds(tableFeed({}), tableFeed({}));
    const { holdings, pricesRead } = await priceHoldings([
      token("0x0000000000000000000000000000000000000002"),
    ]);
    expect(holdings[0]?.usdValue).toBeNull();
    expect(pricesRead).toBe(true);
  });

  it("prices a token a later feed prices", async () => {
    const held = token("0x0000000000000000000000000000000000000003");
    useFeeds(tableFeed({}), tableFeed({ [held.priceId!]: 2.5 }));
    const { holdings, pricesRead } = await priceHoldings([held]);
    expect(holdings[0]?.usdValue).toBe("2.50");
    expect(pricesRead).toBe(true);
  });
});
