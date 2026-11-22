import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MINIMUM_DEPOSIT_USD } from "./cctp.ts";
import { MINIMUM_ORDER_USD } from "./markets.ts";
import { liquidationMove } from "./order.ts";
import { hyperliquidDeposit, WITHDRAWAL_FEE_USD } from "./transfers.ts";

const skill = readFileSync(new URL("SKILL.md", import.meta.url), "utf8").replaceAll(/\s+/gu, " ");

// What the skill tells Claude of Hyperliquid's numbers is what the code holds its moves to.
describe("Hyperliquid's skill", () => {
  it("says the liquidation distances the cards say", () => {
    const pct = (move: number) => `${Math.round(move * 100)}%`;
    expect(skill).toContain(
      `a 3x bitcoin long (maximum 40x) goes at about a ${pct(liquidationMove(true, 3, 40))} fall, ` +
        `a 10x one at about ${pct(liquidationMove(true, 10, 40))}, and a 3x long on a market ` +
        `whose maximum is 3x at about ${pct(liquidationMove(true, 3, 3))}`,
    );
  });

  it("says the smallest order and the withdrawal's fee as the code has them", () => {
    expect(skill).toContain(`no order under $${MINIMUM_ORDER_USD} of position`);
    expect(skill).toContain(`a flat $${WITHDRAWAL_FEE_USD} of every withdrawal`);
    expect(skill).toContain(`must be over $${WITHDRAWAL_FEE_USD + 1}`);
  });

  it("says a deposit's least and Circle's fee as the code has them, as the tool does", () => {
    expect(skill).toContain(
      `Nothing is lost for being small; the least is $${MINIMUM_DEPOSIT_USD}.`,
    );
    expect(skill).toContain("$0.20 when this was written");
    expect(hyperliquidDeposit.description).toContain(`Minimum ${MINIMUM_DEPOSIT_USD} USDC`);
  });
});
