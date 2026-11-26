import { describe, expect, it } from "vitest";

import type { Money } from "./recipe.ts";
import { askLine, differenceUsd, dollars, moneyLine } from "./summaries.ts";

const going = (usd: string) => ({ flow: "in" as const, usd });
const back = (usd: string) => ({ flow: "back" as const, usd });
const moving = (usd: string) => ({ flow: "move" as const, usd });
const leg = (money: Money | null) => ({
  money,
  says: "Buy about $50 of Eli Lilly",
});

describe("money math for the portfolio and the sidebar", () => {
  it("prints dollars without float drift", () => {
    expect(dollars("150.00")).toBe("$150");
    expect(dollars("1234.5")).toBe("$1,234.50");
    expect(dollars("0.07")).toBe("$0.07");
    expect(dollars("1.010787")).toBe("$1.01");
  });

  it("takes today's change in exact cents, either way", () => {
    expect(differenceUsd("100.30", "100.10")).toBe("0.20");
    expect(differenceUsd("96.80", "100.00")).toBe("-3.20");
    // What a specialist made is below zero once it's down.
    expect(differenceUsd("-0.03", "0.10")).toBe("-0.13");
    expect(differenceUsd("-1.00", "-1.25")).toBe("0.25");
  });

  it("says what a waiting card asks", () => {
    expect(askLine([leg(going("100.10")), leg(going("49.90"))])).toBe("2 moves, $150 to put in");
    expect(askLine([leg(going("50"))])).toBe("Buy about $50 of Eli Lilly");
    expect(askLine([])).toBeNull();
    // A move whose words carry no dollars has its money said beside them.
    expect(askLine([{ says: "Sell Yes", money: back("201.50") }])).toBe(
      "Sell Yes, about $201.50 back",
    );
    expect(askLine([{ says: "Stake 60 MON", money: null }])).toBe("Stake 60 MON");
  });

  it("keeps a card's floor a floor, never softening it to a quote", () => {
    const least = (usd: string) => ({ ...back(usd), least: true as const });
    expect(askLine([{ says: "Sell up to 310 shares", money: least("191.68") }])).toBe(
      "Sell up to 310 shares, at least $191.68 back",
    );
    // A floor beside a quote adds up to a quote.
    expect(moneyLine([least("191.68"), back("10")])).toBe("about $201.68 back");
  });

  it("never adds what sells bring back to what buys put in", () => {
    expect(moneyLine([back("41.20"), back("41.20")])).toBe("about $82.40 back");
    expect(moneyLine([going("25"), back("41.20"), null])).toBe("$25 to put in, about $41.20 back");
    expect(moneyLine([null])).toBeNull();
    expect(askLine([leg(back("41.20")), leg(back("12"))])).toBe("2 moves, about $53.20 back");
    expect(askLine([leg(null), leg(null)])).toBe("2 moves");
    expect(askLine([leg(moving("50")), leg(moving("30"))])).toBe("2 moves");
  });
});
