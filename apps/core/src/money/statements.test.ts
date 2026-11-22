import { describe, expect, it } from "vitest";

import { QUANTITY_DECIMALS } from "./fill-key.ts";
import { lineOwners } from "./statements.ts";
import type { StatementFill } from "./venue-statement.ts";
import { parseUnits } from "./usd.ts";

/** Coins in QUANTITY_DECIMALS units, signed. */
const units = (value: string) =>
  value.startsWith("-")
    ? -parseUnits(value.slice(1), QUANTITY_DECIMALS)
    : parseUnits(value, QUANTITY_DECIMALS);
const KEY = "hyperliquid:eth";

/** A fill of ETH from a position of `before` (signed, in coins). */
function line(side: "buy" | "sell", quantity: string, before: string): StatementFill {
  return {
    chain: "hyperliquid",
    instrument: "ETH",
    ref: "hyperliquid:0x01:1",
    at: new Date("2026-10-14T20:21:00Z"),
    side,
    quantity,
    usdValue: "0",
    before: units(before),
  };
}

const books = (...held: [string, string][]) =>
  new Map(held.map(([id, quantity]) => [id, new Map([[KEY, units(quantity)]])]));

describe("the closing rule", () => {
  it("splits a close between the specialists holding it, the acting one first", () => {
    const owners = lineOwners(line("sell", "3", "3"), books(["a", "2"], ["b", "1"]), "b");
    expect(owners).toEqual([
      ["b", units("1")],
      ["a", units("2")],
    ]);
  });

  it("closes Other's share first when no move of Auni's made it", () => {
    // A holds 2 of the 3 held; the other 1 is no specialist's.
    expect(lineOwners(line("sell", "1.5", "3"), books(["a", "2"]), null)).toEqual([
      [null, units("1")],
      ["a", units("0.5")],
    ]);
  });

  it("buys back a short from whoever's sells opened it", () => {
    expect(lineOwners(line("buy", "1", "-1"), books(["a", "-1"]), null)).toEqual([
      ["a", units("1")],
    ]);
  });

  it("gives what opens or grows a position to the acting move, or Other", () => {
    expect(lineOwners(line("buy", "1", "2"), books(["a", "2"]), "b")).toEqual([["b", units("1")]]);
    expect(lineOwners(line("sell", "1", "0"), books(), null)).toEqual([[null, units("1")]]);
  });

  it("splits a fill that turns a long short into the close and the open", () => {
    expect(lineOwners(line("sell", "3", "2"), books(["a", "2"]), "b")).toEqual([
      ["a", units("2")],
      ["b", units("1")],
    ]);
  });
});
