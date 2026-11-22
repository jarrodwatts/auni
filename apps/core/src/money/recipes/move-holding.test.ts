import { describe, expect, it } from "vitest";

import { parseUnits } from "../usd.ts";
import { potLeaving } from "../pot.ts";
import { planMove } from "./move-holding.ts";

const units = (quantity: string) => parseUnits(quantity, 18);

describe("planMove", () => {
  const held = { quantity: "0.0232", usdValue: "4.97" };

  it("moves all of it at its live value when no amount is named", () => {
    expect(planMove({ held, price: held, asked: null, booked: null })).toEqual({
      out: units("0.0232"),
      in: units("0.0232"),
      usdValue: "4.97",
    });
  });

  it("values part of it by its share, to the cent below", () => {
    expect(planMove({ held, price: held, asked: units("0.0116"), booked: null })?.usdValue).toBe(
      "2.48",
    );
  });

  it("never moves more than the source holds now", () => {
    expect(planMove({ held, price: held, asked: units("1"), booked: null })?.in).toBe(
      units("0.0232"),
    );
  });

  it("clears a specialist's books when all it shows leaves, crumbs the wallet never had included", () => {
    const plan = planMove({ held, price: held, asked: null, booked: units("0.02320000001") });
    expect(plan?.out).toBe(units("0.02320000001"));
    expect(plan?.in).toBe(units("0.0232"));
  });

  it("leaves a specialist's books holding just what it still shows when part of it moves", () => {
    // Its books say 10 but the wallet shows it 6: moving 3 leaves books of 3, not 7, so the
    // older specialist can't claim the 3 that moved.
    const short = { quantity: "6", usdValue: "60" };
    const plan = planMove({ held: short, price: short, asked: units("3"), booked: units("10") });
    expect(plan).toEqual({ out: units("7"), in: units("3"), usdValue: "30.00" });
  });

  it("takes only what moves when its books match what it shows", () => {
    expect(
      planMove({ held, price: held, asked: units("0.01"), booked: units("0.0232") })?.out,
    ).toBe(units("0.01"));
  });

  it("values it at the price given, whatever the live one is now", () => {
    // The card showed 0.0232 at $4.97; less is there now, and the price has doubled.
    const now = { quantity: "0.0116", usdValue: "4.97" };
    expect(planMove({ held: now, price: held, asked: units("0.0232"), booked: null })).toEqual({
      out: units("0.0116"),
      in: units("0.0116"),
      usdValue: "2.48",
    });
  });

  it("moves nothing when none is left", () => {
    expect(
      planMove({ held: { ...held, quantity: "0" }, price: held, asked: null, booked: null }),
    ).toBeNull();
  });
});

describe("potLeaving", () => {
  const bought = { chain: "monad", instrument: "nvda", side: "buy" as const, quantity: "1" };
  const leaving = (usdValue: string) => ({ ...bought, side: "sell" as const, usdValue });

  it("lowers the pot by what it cost when it leaves at a gain, so its free cash stays", () => {
    // Pot $100 with $50 in it leaves $50 free, and still does once it leaves worth $80.
    expect(potLeaving("100", [{ ...bought, usdValue: "50" }], leaving("80"))).toBe("50.00");
  });

  it("lowers the pot by what it's worth when it leaves at a loss, which the pot already counted", () => {
    expect(potLeaving("100", [{ ...bought, usdValue: "50" }], leaving("30"))).toBe("70.00");
  });

  it("never lowers it below nothing", () => {
    expect(potLeaving("3", [{ ...bought, usdValue: "5" }], leaving("4.97"))).toBe("0.00");
  });
});
