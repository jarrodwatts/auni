import { describe, expect, it, vi } from "vitest";

import { dayMoves, dayMoveUsd } from "./day-moves.ts";
import type { Holding } from "./portfolio.ts";

const holding = (fields: Partial<Holding>): Holding => ({
  venue: "wallet",
  chain: "solana",
  instrument: "native",
  symbol: "SOL",
  quantity: "1",
  decimals: 9,
  usdValue: "102.00",
  cash: false,
  priceId: "coingecko:solana",
  ...fields,
});

const MIDNIGHT = Date.parse("2026-10-24T00:00:00Z");
const HOUR = 60 * 60_000;
/** A price path from yesterday evening to now, ending in the live price. */
const path = (...prices: number[]) =>
  prices.map((price, index) => ({ at: MIDNIGHT + (index - 1) * HOUR, price }));

const paths = vi.hoisted(() => ({ prices: [] as number[] }));
vi.mock("./history.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pricePaths: (keys: readonly string[]) =>
    new Map(
      keys.map((key) => [
        key,
        Promise.resolve(
          paths.prices.map((price, index) => ({
            at: Date.parse("2026-10-24T00:00:00Z") + (index - 1) * 60 * 60_000,
            price,
          })),
        ),
      ]),
    ),
}));

describe("dayMoveUsd", () => {
  it("moves a token in proportion to its price since midnight", () => {
    // $100 at midnight, $102 now.
    expect(dayMoveUsd(holding({}), path(99, 100, 101, 102), MIDNIGHT)).toBe("2.00");
    expect(dayMoveUsd(holding({ usdValue: "98.00" }), path(100, 100, 98), MIDNIGHT)).toBe("-2.00");
  });

  it("moves an xStock by its price, not by its balance, which carries a multiplier", () => {
    // One share worth $110 now, held on an EVM chain as a balance of 1.097.
    const stock = holding({ chain: "monad", quantity: "1.097", usdValue: "110.00" });
    expect(dayMoveUsd(stock, path(100, 100, 110), MIDNIGHT)).toBe("10.00");
  });

  it("moves a perp by its size times the change in price, gaining on a short when it falls", () => {
    const long = holding({
      venue: "hyperliquid",
      chain: "hyperliquid",
      instrument: "BTC",
      quantity: "0.5",
      priceId: null,
      usdValue: "20",
    });
    expect(dayMoveUsd(long, path(100, 100, 110), MIDNIGHT)).toBe("5.00");
    expect(dayMoveUsd({ ...long, short: true }, path(100, 100, 110), MIDNIGHT)).toBe("-5.00");
  });

  it("moves a prediction share from its price at midnight", () => {
    const share = holding({ venue: "polymarket", quantity: "100", usdValue: "64.00" });
    expect(dayMoveUsd(share, path(0.6, 0.6, 0.64), MIDNIGHT)).toBe("4.00");
  });

  it("keeps cash still and leaves the unknown unknown", () => {
    expect(dayMoveUsd(holding({ cash: true, priceId: null }), null, MIDNIGHT)).toBe("0.00");
    expect(dayMoveUsd(holding({}), null, MIDNIGHT)).toBeNull();
    expect(dayMoveUsd(holding({ usdValue: null }), path(1, 1), MIDNIGHT)).toBeNull();
    // Only a live price, or a history starting after midnight: nothing says what it was then.
    expect(dayMoveUsd(holding({}), [{ at: MIDNIGHT + HOUR, price: 102 }], MIDNIGHT)).toBeNull();
  });

  it("moves what was bought today from what it cost, never from before it was bought", () => {
    // Bought at 11:58 for $1,800, worth $1,798.20 now, though the price is up 1.54% since midnight.
    const nvidia = holding({ chain: "monad", quantity: "9.5", usdValue: "1798.20" });
    const bought = { units: 9.5, usd: 1800 };
    expect(dayMoveUsd(nvidia, path(100, 100, 101.54), MIDNIGHT, bought)).toBe("-1.80");
    // Its cost says it all, so a price history that can't be read still tells it.
    expect(dayMoveUsd(nvidia, null, MIDNIGHT, bought)).toBe("-1.80");
  });

  it("moves what was held at midnight from then, and what was bought since from its cost", () => {
    // One held at $100 at midnight and one bought at $101, both $102 now.
    const two = holding({ quantity: "2", usdValue: "204.00" });
    expect(dayMoveUsd(two, path(100, 100, 102), MIDNIGHT, { units: 1, usd: 101 })).toBe("3.00");
    // What was held at midnight still needs the price then.
    expect(dayMoveUsd(two, null, MIDNIGHT, { units: 1, usd: 101 })).toBeNull();
  });

  it("moves a perp opened today from its entry", () => {
    const short = holding({
      venue: "hyperliquid",
      chain: "hyperliquid",
      instrument: "BTC",
      quantity: "0.5",
      priceId: null,
      usdValue: "15",
      short: true,
    });
    // Opened at $104 (a $52 notional), $110 now: down $3 on its own, not $5 since midnight.
    expect(dayMoveUsd(short, path(100, 100, 110), MIDNIGHT, { units: 0.5, usd: 52 })).toBe("-3.00");
  });
});

describe("dayMoves", () => {
  it("counts only the fills that added to a holding since the day began", async () => {
    paths.prices = [100, 100, 102];
    const two = holding({ quantity: "2", usdValue: "204.00" });
    const fill = (side: "buy" | "sell", quantity: string, usdValue: string, at: number) => ({
      chain: "solana",
      instrument: "native",
      side,
      quantity,
      usdValue,
      createdAt: new Date(at),
    });
    const moves = await dayMoves([two], MIDNIGHT, [
      fill("buy", "1", "90.00", MIDNIGHT - 5 * HOUR),
      // Sold and bought back today: what was bought back moves from its cost.
      fill("sell", "1", "99.00", MIDNIGHT + HOUR),
      fill("buy", "1", "101.00", MIDNIGHT + 2 * HOUR),
      // Another coin's buy is not this one's.
      { ...fill("buy", "5", "5.00", MIDNIGHT + 2 * HOUR), instrument: "other" },
    ]);
    expect(moves).toEqual(["3.00"]);
  });
});
