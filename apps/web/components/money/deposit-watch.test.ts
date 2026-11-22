import type { DepositWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { watchRead, type DepositWatch } from "./deposit-watch";

function deposit(id: string): DepositWire {
  return { id, symbol: "ETH", amount: "0.081", network: "Base", usdValue: "210.60" };
}

describe("watchRead", () => {
  const fresh: DepositWatch = { seen: null, landed: null };

  it("takes what's there at the first read as old news", () => {
    const watch = watchRead(fresh, [deposit("earlier")]);
    expect(watch).toEqual({ seen: new Set(["earlier"]), landed: null });
    expect(watchRead(watch, [deposit("earlier")])).toBe(watch);
  });

  it("lands on the newest deposit not seen before", () => {
    const watch = watchRead(fresh, [deposit("earlier")]);
    const read = [deposit("newest"), deposit("next"), deposit("earlier")];
    expect(watchRead(watch, read).landed?.id).toBe("newest");
  });

  it("lets a later landing take the place of the one before, as a test send's", () => {
    const test = watchRead(watchRead(fresh, []), [deposit("test")]);
    expect(watchRead(test, [deposit("test")])).toBe(test);
    expect(watchRead(test, [deposit("real"), deposit("test")]).landed?.id).toBe("real");
  });

  it("keeps what landed once it's no longer listed", () => {
    const landed = watchRead(watchRead(fresh, []), [deposit("first")]);
    expect(watchRead(landed, [])).toBe(landed);
  });
});
