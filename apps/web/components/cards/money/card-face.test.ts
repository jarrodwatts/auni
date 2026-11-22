import {
  AMOUNT,
  fillFace,
  type ActionPlanLeg,
  type ActionRecordId,
  type CardFace,
} from "@auni/shared";
import { describe, expect, it } from "vitest";

import { moveRows, planLeg } from "./move-rows";

const usdc = (baseUnits: string) => ({ baseUnits, currency: { code: "USDC", decimals: 6 } });

const face: CardFace = {
  title: `Buy Yes for ${AMOUNT}`,
  action: `Buy ${AMOUNT}`,
  working: `Buying ${AMOUNT} of Yes`,
  context: "Will it rain?",
  figures: [
    { label: "You pay", value: AMOUNT },
    { label: "Price", value: "62¢" },
  ],
  finePrint: null,
  receipt: { title: "Bought Yes", detail: "Will it rain?", amount: "spent" },
};

describe("fillFace", () => {
  it("puts the card's own amount wherever the face says it, and nowhere else", () => {
    expect(fillFace(face, usdc("1000500000"))).toMatchObject({
      title: "Buy Yes for $1,000.50",
      action: "Buy $1,000.50",
      working: "Buying $1,000.50 of Yes",
      context: "Will it rain?",
      figures: [
        { label: "You pay", value: "$1,000.50" },
        { label: "Price", value: "62¢" },
      ],
      receipt: { title: "Bought Yes", amount: "$1,000.50" },
    });
    expect(fillFace(face, usdc("50000000")).action).toBe("Buy $50");
  });

  it("says what a sale brought back only once it brought something", () => {
    const sale: CardFace = { ...face, receipt: { ...face.receipt, amount: "back" } };
    expect(fillFace(sale, usdc("3980000")).receipt.amount).toBe("$3.98 back");
    expect(fillFace(sale, usdc("0")).receipt.amount).toBeNull();
  });

  it("says no amount on a receipt whose face asks for none", () => {
    const quiet: CardFace = { ...face, receipt: { ...face.receipt, amount: null } };
    expect(fillFace(quiet, usdc("50000000")).receipt.amount).toBeNull();
  });
});

const card = {
  actionReference: "leg" as ActionRecordId,
  venue: "auni" as const,
  logoUrl: null,
  logoName: null,
  summary: "Put $50 of USDC into Aave on Base",
  line: null,
  lines: [{ label: "You give", value: "$50 of USDC on Base" }],
  details: {},
  amount: usdc("50000000"),
  flow: "in" as const,
  status: "awaiting_permission" as const,
} satisfies Partial<ActionPlanLeg>;

/** A bet's face, as its move writes it: on a plan it reads as its market, and says it is betting. */
const bet: CardFace = {
  ...face,
  context: "Will it snow?",
  pick: {
    name: "Will it snow?",
    tag: "Yes",
    verbs: { now: "Betting on", done: "Bet on", failed: "Didn't bet on" },
  },
};

describe("a plan's row for a bet", () => {
  it("says it is betting from its card's face, whichever venue the market is on", () => {
    const plan = planLeg({ ...card, tool: "polymarket_order", card: bet });
    const [row] = moveRows(
      [],
      [
        {
          ...plan,
          status: "running",
          started: true,
          held: false,
          error: null,
          failureKind: null,
          retryable: false,
        },
      ],
    );
    expect(row!.label).toBe("Betting on Will it snow?");
    expect(row!.tags).toEqual([{ text: "Yes", tone: "plain" }]);
  });
});
