import { describe, expect, it } from "vitest";

import { dayMoveUsd } from "./day-moves.ts";
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
});
