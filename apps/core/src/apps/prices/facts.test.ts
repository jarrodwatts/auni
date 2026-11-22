import { afterEach, describe, expect, it, vi } from "vitest";

import { priceFacts } from "./facts.ts";
import main from "./fixtures/meta-and-asset-ctxs.json";
import xyz from "./fixtures/meta-and-asset-ctxs-xyz.json";

// A stock's mark, as the stock catalog would give it.
vi.mock("../../money/swaps/stock-index.ts", () => ({
  stockLogo: async (ticker: string) =>
    `https://xstocks-metadata.backed.fi/logos/tokens/${ticker}x.png`,
}));

// Hyperliquid's metaAndAssetCtxs on 2026-11-08, its own markets and the xyz dex, cut to the 30
// most traded of each and the fields read.
function answering() {
  const fetched = vi.fn(async (_url: string, init: RequestInit) => {
    const { dex } = JSON.parse(String(init.body)) as { dex?: string };
    return Response.json(dex === "xyz" ? xyz : main);
  });
  vi.stubGlobal("fetch", fetched);
  return fetched;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const signal = new AbortController().signal;

describe("priceFacts", () => {
  it("tells the day's three biggest moves among the most traded markets, each wearing its coin", async () => {
    answering();
    const facts = await priceFacts({ holdings: [] }, signal);
    expect(facts.map(({ label }) => label)).toEqual([
      "ENA on Hyperliquid",
      "PUMP on Hyperliquid",
      "SOXL on Hyperliquid",
    ]);
    expect(facts[0]).toEqual({
      text: "ENA is down 3.8% in the last day on Hyperliquid, at $0.1548, with $11.8M traded.",
      label: "ENA on Hyperliquid",
      link: "https://app.hyperliquid.xyz/trade/ENA",
      image: "https://app.hyperliquid.xyz/coins/ENA.svg",
      starts: [
        {
          statement: "ENA is down 3.8% today.",
          action: "Why?",
          prompt:
            "ENA is down 3.8% in the last day on Hyperliquid. What's behind the move, and is there a take in it for me?",
        },
      ],
    });
  });

  it("tells the day of what the owner holds, a stock by its xStock too, wearing the stock's mark", async () => {
    answering();
    const facts = await priceFacts(
      {
        holdings: [
          { symbol: "NVDAx", name: "NVIDIA", usdValue: "120.00", image: null },
          { symbol: "ETH", name: "Ethereum", usdValue: "80.00", image: null },
          { symbol: "MYSTERY", name: "Mystery", usdValue: "5.00", image: null },
        ],
      },
      signal,
    );
    expect(facts.slice(3)).toEqual([
      {
        text: "NVDA, which the owner holds, is down 0.2% in the last day on Hyperliquid, at $187.53.",
        label: "NVDA on Hyperliquid",
        link: "https://app.hyperliquid.xyz/trade/xyz:NVDA",
        image: "https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png",
        starts: [
          {
            statement: "Your NVDA is down 0.2%.",
            action: "What next?",
            prompt:
              "NVDA, which I hold, is down 0.2% in the last day. What's going on with it, and should I do anything?",
          },
        ],
      },
      expect.objectContaining({ label: "ETH on Hyperliquid" }),
    ]);
  });

  it("says a mover the owner holds is theirs", async () => {
    answering();
    const facts = await priceFacts(
      { holdings: [{ symbol: "PUMP", name: "Pump", usdValue: "9.00", image: null }] },
      signal,
    );
    expect(facts).toHaveLength(3);
    expect(facts[1]!.text).toMatch(/^PUMP, which the owner holds, is down 3\.6%/u);
    expect(facts[1]!.starts[0]!.statement).toBe("Your PUMP is down 3.6%.");
  });
});
