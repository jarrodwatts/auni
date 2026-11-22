import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { solanaPrice } from "./jupiter.ts";

const JNJX = "XsGVi5eo1Dh2zUpic4qACcjuWGjNv8GCt3dm5XcX6Dn";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/** Jupiter's /price/v3 answer for one mint, as it reads on the wire. */
function answering(mint: string, price: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ [mint]: price })),
  );
}

beforeEach(() => {
  process.env.JUPITER_API_KEY = "test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JUPITER_API_KEY;
});

describe("solanaPrice", () => {
  it("prices an xStock at its share, not at its token's last swap", async () => {
    // As Jupiter answered for JNJx on 2026-10-30: its last swap, in an $18 pool, was 13% off.
    answering(JNJX, {
      usdPrice: 242.74,
      liquidity: 17.95,
      stockData: { id: "xstocks", price: 278.97 },
      scaledUiConfig: {
        multiplier: 1.016,
        newMultiplier: 1.0196,
        newMultiplierEffectiveAt: "2026-08-25T00:30:00Z",
      },
    });
    expect(await solanaPrice(JNJX)).toEqual({ usdPrice: 278.97, multiplier: 1.0196 });
  });

  it("prices any other token at its last swap", async () => {
    answering(BONK, { usdPrice: 0.0000123 });
    expect(await solanaPrice(BONK)).toEqual({ usdPrice: 0.0000123, multiplier: 1 });
  });
});
