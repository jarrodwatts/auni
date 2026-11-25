import { expect, it } from "vitest";

import type { Holding } from "../../money/portfolio.ts";
import aave from "./index.ts";

// Savings in a take read as "Cash", the same word as the cash beside it that earns nothing (2026-11-25).
it("names savings for what they are, and how much of Aave's token they are", async () => {
  const savings: Holding = {
    venue: "aave",
    chain: "monad",
    instrument: "0x35a73BAcb179d3740395A3ceCc87FF2e581d6042",
    symbol: "aUSDC",
    quantity: "4015.37",
    decimals: 6,
    usdValue: "4015.37",
    cash: true,
    priceId: null,
  };
  expect(await aave.account!.face(savings)).toEqual({
    name: "Savings on Aave",
    detail: "4,015 aUSDC",
    logoUrl: null,
  });
});
