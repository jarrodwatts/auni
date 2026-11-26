import { describe, expect, it } from "vitest";

import { exchangeOf } from "./exchange";

const pays = { label: "You pay", value: "$250", role: "pays" as const };
const gets = { label: "You get, about", value: "1.4297 shares", role: "gets" as const };
const price = { label: "Price", value: "$174.69" };
const costs = { label: "Price impact", value: "$0.25" };

describe("exchangeOf", () => {
  it("says the amount once: what it gets goes under the title, at its price", () => {
    expect(exchangeOf([pays, gets, price, costs], "$250")).toEqual({
      scene: null,
      result: "About 1.4297 shares at $174.69",
      facts: [costs],
    });
  });

  it("says what a sale sends when what comes back is the amount", () => {
    const sells = { label: "You sell, up to", value: "310 shares", role: "pays" as const };
    const back = { label: "You get, at least", value: "$191.68", role: "gets" as const };
    expect(exchangeOf([sells, back, { label: "Price", value: "62¢" }], "$191.68")).toEqual({
      scene: null,
      result: "Up to 310 shares at 62¢",
      facts: [],
    });
  });

  it("draws both sides as a story when neither is the card's amount", () => {
    const sends = { label: "You send", value: "60 MON", role: "pays" as const };
    const sMon = { label: "You get", value: "60 sMON", role: "gets" as const };
    expect(exchangeOf([sends, sMon, price], "$24.30")).toEqual({
      scene: { pays: sends, gets: sMon },
      result: null,
      facts: [price],
    });
  });

  it("keeps a side whose label says nothing of how sure it is as a fact", () => {
    const margin = { label: "You put in", value: "$1,000", role: "pays" as const };
    const position = { label: "Position", value: "$3,000", role: "gets" as const };
    const leverage = { label: "Leverage", value: "3x" };
    expect(exchangeOf([margin, position, leverage], "$1,000")).toEqual({
      scene: null,
      result: null,
      facts: [position, leverage],
    });
  });

  it("draws no story with only one side, and drops the figure the head already says", () => {
    const amount = { label: "Amount", value: "$250" };
    expect(exchangeOf([amount, gets, price], "$250")).toEqual({
      scene: null,
      result: null,
      facts: [gets, price],
    });
  });

  it("takes the first of each side when a face names more", () => {
    const least = { label: "You get, at least", value: "$19.97", role: "gets" as const };
    const sends = { label: "Leaves Polymarket", value: "$20", role: "pays" as const };
    const result = exchangeOf([sends, gets, least], "$20");
    expect(result.result).toBe("About 1.4297 shares");
    expect(result.facts).toEqual([least]);
  });
});
