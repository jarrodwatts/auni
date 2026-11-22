import { describe, expect, it } from "vitest";

import {
  amountLabel,
  closeResult,
  headline,
  perpLine,
  perpTag,
  pickVerb,
  restLabel,
  sum,
} from "./pick-money";

const leg = (dollars: number, flow: "in" | "back") => ({
  amount: { baseUnits: String(dollars * 1_000_000), currency: { code: "USDC", decimals: 6 } },
  flow,
});

describe("a proposal's money", () => {
  it("never adds what sells bring back to what buys put in", () => {
    const legs = [leg(25, "in"), leg(15, "in"), leg(41.2, "back")];
    expect(sum(legs, "in")).toBe(40_000_000n);
    expect(sum(legs, "back")).toBe(41_200_000n);
  });

  it("heads a card with what goes in, and with what comes back only when nothing does", () => {
    expect(headline([leg(25, "in"), leg(41.2, "back")])).toBe("in");
    expect(headline([leg(41.2, "back"), leg(27.85, "back")])).toBe("back");
    // A card whose picks move no money heads with what goes in.
    expect(headline([leg(0, "in")])).toBe("in");
  });

  it("marks money coming back, and says nothing for a pick that moves none", () => {
    expect(amountLabel(25_000_000n, 6, "in")).toBe("$25");
    expect(amountLabel(41_200_000n, 6, "back")).toBe("+$41.20");
    expect(amountLabel(0n, 6, "back")).toBeNull();
  });

  it("totals the picks behind N more only when they all go one way", () => {
    expect(restLabel([leg(41.2, "back"), leg(27.85, "back")])).toBe("+$69.05");
    expect(restLabel([leg(10, "in"), leg(5, "in")])).toBe("$15");
    expect(restLabel([leg(10, "in"), leg(41.2, "back")])).toBeNull();
  });
});

describe("a leveraged pick", () => {
  const perp = (side: "long" | "short", leverage: number) => ({
    side,
    leverage,
    size: "$60",
    liquidationMove: 0.3249,
  });

  it("says what it holds and how far the price can go before it's gone, rounded toward safety", () => {
    expect(perpTag(perp("short", 3))).toBe("3x short");
    expect(perpLine(perp("long", 3))).toBe("$60 position, gone if it falls 30%");
    expect(perpLine(perp("short", 3))).toBe("$60 position, gone if it rises 30%");
    expect(perpLine({ ...perp("long", 1), liquidationMove: 1 })).toBe("$60 position");
  });
});

describe("a pick that closes a perp", () => {
  const closing = (all: boolean, pnlUsd: number) => ({
    side: "long" as const,
    leverage: 3,
    size: "$21",
    closes: { all, pnlUsd },
  });

  it("says which bet it lets go of, and what that locks in", () => {
    expect(perpLine(closing(true, -4.63))).toBe("Your 3x long");
    expect(perpLine(closing(false, -4.63))).toBe("$21 of your 3x long");
    expect(closeResult(closing(true, -4.63))).toEqual({ text: "down $4.63", down: true });
    expect(closeResult(closing(true, 2.1))).toEqual({ text: "up $2.10", down: false });
    expect(closeResult(closing(true, 0.004))).toBeNull();
  });

  it("names what each pick does on a card that both buys and sells", () => {
    expect(pickVerb({ flow: "back", perp: closing(true, 0) })).toBe("Close");
    expect(pickVerb({ flow: "in", perp: { side: "long", leverage: 5, size: "$34" } })).toBe("Open");
    expect(pickVerb({ flow: "back" })).toBe("Sell");
    expect(pickVerb({ flow: "in" })).toBe("Buy");
  });
});
