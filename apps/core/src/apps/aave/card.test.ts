import { cardFaceSchema, fillFace } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { supplyFace, withdrawFace } from "./card.ts";

const usdc = (baseUnits: string) => ({ baseUnits, currency: { code: "USDC", decimals: 6 } });

describe("Aave's faces", () => {
  it("say a supply as saving, with the rate as a figure of its own", () => {
    const face = fillFace(supplyFace("Monad", "4.18"), usdc("500000000"));
    expect([face.title, face.action, face.context]).toEqual([
      "Save on Aave",
      "Save $500",
      "From your wallet on Monad",
    ]);
    expect(face.figures).toEqual([{ label: "Earning now", value: "4.18% a year" }]);
    expect(face.receipt).toMatchObject({ title: "Saved on Aave", detail: "On Monad" });
    expect(cardFaceSchema.parse(supplyFace("Monad", "4.18"))).toBeTruthy();
  });

  it("leave the rate unsaid when the pool couldn't be read, rather than guess it", () => {
    const face = supplyFace("Base", null);
    expect(face.figures).toEqual([]);
    expect(face.finePrint).toBe("Savings count as your cash, a dollar each.");
  });

  it("say a withdrawal as savings coming back to the wallet as cash", () => {
    const face = fillFace(withdrawFace("Monad"), usdc("1000000000"));
    expect([face.title, face.action, face.context]).toEqual([
      "Take out of savings on Aave",
      "Take out $1,000",
      "To your wallet on Monad",
    ]);
    expect(cardFaceSchema.parse(withdrawFace("Monad"))).toBeTruthy();
  });
});
