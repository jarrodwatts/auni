import { describe, expect, it } from "vitest";

import type { Holding } from "@/lib/data/views";

import { takeValue } from "./use-takes";

const holding = (value: bigint, change: bigint | null): Holding => ({
  id: `h${value}`,
  name: "BTC 3x long",
  detail: "Hyperliquid",
  logoUrl: null,
  value: { baseUnits: value.toString() } as Holding["value"],
  todayChangeBaseUnits: change === null ? null : change.toString(),
});

describe("takeValue", () => {
  it("adds up what a take holds, and how it moved today", () => {
    expect(takeValue([holding(2_000_000n, 50_000n), holding(1_000_000n, -20_000n)])).toEqual({
      value: 3_000_000n,
      change: 30_000n,
    });
  });

  it("says no change at all when one holding's day isn't known, rather than part of it", () => {
    expect(takeValue([holding(2_000_000n, 50_000n), holding(1_000_000n, null)])).toEqual({
      value: 3_000_000n,
      change: null,
    });
  });

  it("is no take when it holds nothing", () => {
    expect(takeValue([])).toBeNull();
    expect(takeValue([holding(0n, 0n)])).toBeNull();
  });
});
