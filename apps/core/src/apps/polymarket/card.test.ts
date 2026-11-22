import { cardFaceSchema, fillFace } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { orderFace } from "./card.ts";

const usdc = (baseUnits: string) => ({ baseUnits, currency: { code: "USDC", decimals: 6 } });
const order = {
  side: "buy" as const,
  question: "Will it rain?",
  outcome: "Yes",
  price: 0.62,
  shares: "8.06",
  worst: 0.63,
};

const WAITS =
  "Cash from a sale or a payout waits in your Polymarket wallet and pays for your next buy there. Ask Auni to bring it back to your own wallet whenever you like.";

describe("a Polymarket order's face", () => {
  it("reads a buy as the outcome, stake and share price", () => {
    const content = fillFace(orderFace(order), usdc("5000000"));
    expect(content.title).toBe("Buy Yes for $5");
    expect(content.action).toBe("Buy $5");
    expect(content.context).toBe("Will it rain?");
    expect(content.figures).toEqual([
      { label: "You pay", value: "$5" },
      { label: "You get, about", value: "8.06 shares" },
      { label: "Price", value: "62¢" },
      { label: "Price, at most", value: "63¢" },
    ]);
    expect(content.finePrint).toBe(
      `Each share pays $1 if the answer is Yes, and Polymarket collects it for you when the market resolves. ${WAITS}`,
    );
    expect(content.price).toBe("62¢");
  });

  it("says the price as its bound is, so it never reads over the most a buy pays", () => {
    // A live card read "Price 100¢" over "Price, at most 99.9¢" (finding 97).
    const face = orderFace({ ...order, price: 0.996, worst: 0.999 });
    expect(face.figures).toContainEqual({ label: "Price", value: "99.6¢" });
    expect(face.figures).toContainEqual({ label: "Price, at most", value: "99.9¢" });
    expect(face.price).toBe("99.6¢");
  });

  it("keeps what a sale brought back on its receipt", () => {
    const face = orderFace({ ...order, side: "sell", price: 0.5, shares: "10", worst: 0.485 });
    // Where the cash lands, and that it comes home when asked, is said where it is about to land.
    expect(face.finePrint).toBe(`It sells at the best price on Polymarket's book. ${WAITS}`);
    expect(face.figures).toEqual([
      { label: "Shares", value: "10" },
      { label: "Price", value: "50¢" },
      { label: "Price, at least", value: "48.5¢" },
    ]);
    expect(fillFace(face, usdc("3980000")).receipt).toMatchObject({
      title: "Sold Yes",
      detail: "Will it rain?",
      amount: "$3.98 back",
    });
  });

  it("reads on a plan as its market with the outcome as a tag, and a buy as a bet", () => {
    expect(orderFace(order).pick).toEqual({
      name: "Will it rain?",
      tag: "Yes",
      verbs: { now: "Betting on", done: "Bet on", failed: "Didn't bet on" },
    });
    expect(orderFace({ ...order, side: "sell" }).pick).toEqual({
      name: "Will it rain?",
      tag: "Yes",
    });
  });

  it("leaves out what couldn't be priced, and is a face of the one shape either way", () => {
    for (const side of ["buy", "sell"] as const) {
      const face = orderFace({ ...order, side, price: null, shares: null });
      expect(face.figures.map(({ label }) => label)).toEqual(
        side === "buy" ? ["You pay", "Price, at most"] : ["Price, at least"],
      );
      expect(face.price).toBeNull();
      expect(cardFaceSchema.parse(face)).toEqual(face);
      expect(cardFaceSchema.parse(orderFace({ ...order, side }))).toEqual(
        orderFace({ ...order, side }),
      );
    }
  });
});
