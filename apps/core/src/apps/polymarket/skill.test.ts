import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CASH_WAITS } from "./card.ts";
import { orderFee } from "./orders.ts";

const skill = readFileSync(new URL("SKILL.md", import.meta.url), "utf8").replaceAll(/\s+/gu, " ");

// What the skill tells Claude of Polymarket's fee is what the code charges a fill.
describe("Polymarket's skill", () => {
  it("works its fee example as the code charges it", () => {
    // A rate of 0.05 on one share (a million micros) bought at 50 cents, then at 90.
    const fees = { rateMicros: 50_000n, exponent: 1n };
    expect(orderFee(500_000n, 1_000_000n, fees)).toBe(12_500n);
    expect(orderFee(900_000n, 1_000_000n, fees)).toBe(4_500n);
    expect(skill).toContain(
      "at a rate of 0.05, a share bought at 50 cents costs 1.25 cents more (2.5% of the stake), and one at 90 cents under half a cent",
    );
  });

  it("says of its cash what its cards say, and nowhere that it can't come home", () => {
    expect(CASH_WAITS).toContain("Ask Auni to bring it back to your own wallet");
    expect(skill).toContain(
      "the owner's to bring home whenever they like with `polymarket_withdraw`",
    );
    expect(skill).not.toMatch(/can't (bring|come)[^.]*(home|back)[^.]*yet/iu);
  });

  it("says the pool's fee and the card's slack as the code holds them", () => {
    // The pool's tier is 100 hundredths of a basis point, and a card's least sits 10 basis points under.
    expect(skill).toContain("keeps a hundredth of a percent, a cent on $100");
    expect(skill).toContain("the least it accepts, a tenth of a percent under that");
  });
});
