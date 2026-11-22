import { describe, expect, it } from "vitest";

import { madeUsd, unpricedOf } from "./made.ts";
import { type Holding, type Portfolio } from "./portfolio.ts";
import { plainCashUsd } from "./readings.ts";

const holding = (venue: Holding["venue"], usdValue: string, cash: boolean): Holding => ({
  venue,
  chain: "monad",
  instrument: venue,
  symbol: "USDC",
  quantity: usdValue,
  decimals: 6,
  usdValue,
  cash,
  priceId: null,
});

const portfolio = (holdings: Holding[], onTheWay: string) =>
  ({ holdings, onTheWay: { usdValue: onTheWay, moves: [] } }) as unknown as Portfolio;

describe("plainCashUsd", () => {
  it("is cash that never earns: wallet and venue cash and money on its way, not savings", () => {
    expect(
      plainCashUsd(
        portfolio(
          [
            holding("wallet", "30.00", true),
            holding("hyperliquid", "5.00", true),
            holding("aave", "100.00", true),
            holding("wallet", "25.00", false),
          ],
          "12.35",
        ),
      ),
    ).toBeCloseTo(47.35);
  });
});

describe("madeUsd", () => {
  // Savings of $100 put in with a fill, grown to $100.40.
  it("counts savings interest, but not the money moved into savings", () => {
    expect(madeUsd(130.4, 30, [{ at: 1, usd: 100 }])).toBe("0.40");
  });

  it("counts only the trades made by then", () => {
    const flows = [
      { at: 1, usd: 25 },
      { at: 3, usd: -10 },
    ];
    expect(madeUsd(24.88, 0, flows, 2)).toBe("-0.12");
  });
});

describe("what money made, as money comes and goes", () => {
  // $40 of USDC and 10 NVDAx bought for $100 (monad:nvdax), now worth $105.
  const NVDAX = { chain: "monad", instrument: "0xNVDAX" };
  const bought = { at: 1, usd: 100, key: "monad:0xnvdax" };

  it("counts no withdrawal of cash as a loss", () => {
    expect(madeUsd(145, 40, [bought])).toBe("5.00");
    // 50 cents of USDC sent to someone: the value and the plain cash both fall by it.
    expect(madeUsd(144.5, 39.5, [bought])).toBe("5.00");
  });

  it("counts no token sent out, or arriving, as a loss or a gain", () => {
    // 1 NVDAx, $10.50 then, sent out; then $20 of ETH arriving from an exchange.
    const sent = { at: 2, usd: -10.5, key: "monad:0xnvdax" };
    const arrived = { at: 3, usd: 20, key: "ethereum:native" };
    expect(madeUsd(134.5, 40, [bought, sent])).toBe("5.00");
    expect(madeUsd(154.5, 40, [bought, sent, arrived])).toBe("5.00");
  });

  it("counts no token that begins to count as a gain: its worth then is put in", () => {
    // 12 WMON, $0.21, held before Auni read it, kept as put in when it began to count.
    const kept = { at: 2, usd: 0.21, key: "monad:0xwmon" };
    expect(madeUsd(145.21, 40, [bought, kept])).toBe("5.00");
  });

  it("leaves a holding Auni can't price out, with the money moved into it", () => {
    // NVDAx's price feed stops answering: it is in no value, so its $100 is no loss.
    const unpriced = unpricedOf([{ ...NVDAX, usdValue: null }]);
    expect(madeUsd(40, 40, [bought], Infinity, unpriced)).toBe("0.00");
    // Priced again at $104: what it did meanwhile counts.
    expect(madeUsd(144, 40, [bought])).toBe("4.00");
  });
});
