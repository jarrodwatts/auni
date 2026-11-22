import { describe, expect, it, vi } from "vitest";

import { info } from "./api.ts";
import { hyperliquidMarkets } from "./markets.ts";

vi.mock(import("./api.ts"), async (original) => ({ ...(await original()), info: vi.fn() }));

/** The main dex with SOL and BTC, and the xyz dex with NVDA and BTCD, as Hyperliquid's info lists them. */
vi.mocked(info).mockImplementation(async (body) => {
  if (body.type === "perpDexs") return [null, { name: "xyz" }] as never;
  const listed =
    body.dex === "xyz"
      ? [
          ["xyz:NVDA", "181.2"],
          ["xyz:BTCD", "58.1"],
        ]
      : [
          ["SOL", "182.4"],
          ["BTC", "97000"],
        ];
  return [
    { universe: listed.map(([name]) => ({ name, szDecimals: 2, maxLeverage: 20 })) },
    listed.map(([, markPx]) => ({ markPx, dayNtlVlm: "1000", funding: "0.00001" })),
  ] as never;
});

const found = async (query: string) =>
  (await hyperliquidMarkets.handler({ query })).structuredContent?.found;

describe("hyperliquid_markets", () => {
  it("says the one market it found by its ticker and price, a HIP-3 one by its ticker alone", async () => {
    expect(await found("sol")).toBe("SOL $182.40");
    expect(await found("nvda")).toBe("NVDA $181.20");
  });

  it("counts the markets when several match, or says it found none", async () => {
    expect(await found("btc")).toBe("2 markets");
    expect(await found("doge")).toBe("No markets");
  });
});
