import type { DepositWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { landedTotal, stillNeeded } from "./deposit-watch";

function deposit(id: string, usdValue = "210.60"): DepositWire {
  return { id, symbol: "USDC", amount: usdValue, network: "Base", usdValue, cash: "base" };
}

describe("landedTotal", () => {
  it("counts a test send and the real one after it", () => {
    expect(landedTotal([deposit("real", "49"), deposit("test", "1")])).toBe(50_000_000n);
  });
});

describe("stillNeeded", () => {
  const base = { usd: "50", chain: "base" } as const;

  it("is what a card still waits for, and nothing once it's covered", () => {
    expect(stillNeeded(base, [deposit("a", "10")])).toBe(40_000_000n);
    expect(stillNeeded(base, [deposit("a", "1"), deposit("b", "49")])).toBe(0n);
    expect(stillNeeded(base, [deposit("a", "75.25")])).toBe(0n);
    expect(stillNeeded(null, [])).toBe(0n);
  });

  // $50 of MON cleared a card short $50 of USDC on Base: Add money said Done while the card
  // still said it was short (review of 2026-11-25).
  it("counts only USDC on the network the card is short on", () => {
    const mon: DepositWire = {
      ...deposit("mon", "50"),
      symbol: "MON",
      network: "Monad",
      cash: null,
    };
    const eth: DepositWire = { ...deposit("eth", "50"), symbol: "ETH", cash: null };
    const onMonad: DepositWire = {
      ...deposit("usdc-monad", "50"),
      network: "Monad",
      cash: "monad",
    };
    expect(stillNeeded(base, [mon, eth, onMonad])).toBe(50_000_000n);
    expect(stillNeeded(base, [mon, deposit("usdc", "20")])).toBe(30_000_000n);
  });

  // 24.995 and 25.005 USDC, exactly 50, left a card short "1¢ to go": each one's dollars are cut
  // to the cent, $24.99 and $25.00 (review of 2026-11-25).
  it("counts USDC to the last unit, not by its dollars cut to the cent", () => {
    const landed = [
      { ...deposit("a", "24.99"), amount: "24.995" },
      { ...deposit("b", "25.00"), amount: "25.005" },
    ];
    expect(landedTotal(landed)).toBe(50_000_000n);
    expect(stillNeeded(base, landed)).toBe(0n);
  });
});
