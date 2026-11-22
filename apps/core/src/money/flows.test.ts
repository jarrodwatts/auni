import { describe, expect, it } from "vitest";

import { flowsFrom, flowsOf } from "./flows.ts";
import { madeUsd } from "./made.ts";

const DAY = 86_400_000;

describe("perp flows on the venue's margin basis", () => {
  const perp = { instrument: "BTC", perp: true } as const;

  it("puts in only the margin, so leverage alone is no loss", () => {
    // $500 of BTC at 5x: $100 of margin, worth $100 while the price stands still.
    const flows = flowsOf([
      { ...perp, at: 0, side: "buy", usd: 500, quantity: 0.005, leverage: 5 },
    ]);
    expect(flows).toEqual([{ at: 0, usd: 100 }]);
  });

  it("takes out the margin plus what the position made when it closes", () => {
    // Opened at $100,000, closed at $110,000: $100 margin comes back with $50 made.
    const flows = flowsOf([
      { ...perp, at: 0, side: "buy", usd: 500, quantity: 0.005, leverage: 5 },
      { ...perp, at: DAY, side: "sell", usd: 550, quantity: 0.005, leverage: null },
    ]);
    expect(flows[1]?.usd).toBeCloseTo(-150);
    expect(madeUsd(0, 0, flows)).toBe("50.00");
  });

  it("re-margins the whole position when leverage changes", () => {
    // $500 at 5x, then $500 more at 10x, price flat: $1,000 at 10x locks $100 in all.
    const flows = flowsOf([
      { ...perp, at: 0, side: "buy", usd: 500, quantity: 0.005, leverage: 5 },
      { ...perp, at: DAY, side: "buy", usd: 500, quantity: 0.005, leverage: 10 },
    ]);
    expect(flows.reduce((sum, flow) => sum + flow.usd, 0)).toBeCloseTo(100);
  });

  it("counts spot trades at their full value", () => {
    const flows = flowsOf([
      {
        at: 0,
        side: "buy",
        usd: 200,
        quantity: 1,
        instrument: "NVDA",
        perp: false,
        leverage: null,
      },
      {
        at: DAY,
        side: "sell",
        usd: 50,
        quantity: 0.2,
        instrument: "NVDA",
        perp: false,
        leverage: null,
      },
    ]);
    expect(flows.map((flow) => flow.usd)).toEqual([200, -50]);
  });
});

describe("recorded fills as flows", () => {
  const recorded = (chain: string, instrument: string) => ({
    threadId: null,
    side: "buy" as const,
    usdValue: "500",
    quantity: "0.005",
    chain,
    instrument,
    createdAt: new Date(0),
    leverage: 5,
  });

  // The same $500 at 5x: margin where the account is leveraged, the whole of it anywhere else.
  it("puts in the margin of a fill in a leveraged account, and the whole of any other", () => {
    expect(flowsFrom([recorded("hyperliquid", "BTC")])).toEqual([
      { at: 0, usd: 100, key: "hyperliquid:btc" },
    ]);
    expect(flowsFrom([recorded("base", "0xabc")])).toEqual([
      { at: 0, usd: 500, key: "base:0xabc" },
    ]);
    expect(flowsFrom([recorded("polygon", "123456789")])).toEqual([
      { at: 0, usd: 500, key: "polygon:123456789" },
    ]);
  });
});
