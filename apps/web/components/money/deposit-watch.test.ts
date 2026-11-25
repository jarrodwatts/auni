import type { DepositWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { landedTotal, NOT_WATCHED, stillNeeded, watchRead } from "./deposit-watch";

function deposit(id: string, usdValue = "210.60"): DepositWire {
  return { id, symbol: "USDC", amount: usdValue, network: "Base", usdValue, cash: "base" };
}

describe("watchRead", () => {
  it("takes what's there at the first read as old news", () => {
    const watch = watchRead(NOT_WATCHED, [deposit("earlier")]);
    expect(watch).toEqual({ seen: new Set(["earlier"]), landed: [] });
    expect(watchRead(watch, [deposit("earlier")])).toBe(watch);
  });

  it("lands every deposit not seen before, newest first", () => {
    const watch = watchRead(NOT_WATCHED, [deposit("earlier")]);
    const read = [deposit("newest"), deposit("next"), deposit("earlier")];
    expect(watchRead(watch, read).landed.map(({ id }) => id)).toEqual(["newest", "next"]);
  });

  it("counts a test send and the real one after it", () => {
    const test = watchRead(watchRead(NOT_WATCHED, []), [deposit("test", "1")]);
    expect(watchRead(test, [deposit("test", "1")])).toBe(test);
    const both = watchRead(test, [deposit("real", "49"), deposit("test", "1")]);
    expect(both.landed.map(({ id }) => id)).toEqual(["real", "test"]);
    expect(landedTotal(both.landed)).toBe(50_000_000n);
  });

  it("keeps what landed once it's no longer listed", () => {
    const landed = watchRead(watchRead(NOT_WATCHED, []), [deposit("first")]);
    expect(watchRead(landed, [])).toBe(landed);
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
});
