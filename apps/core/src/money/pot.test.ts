import { describe, expect, it } from "vitest";

import type { PotFill } from "./books.ts";
import { QUANTITY_DECIMALS } from "./fill-key.ts";
import { potOf } from "./pot.ts";
import { formatUnits } from "./usd.ts";

const fill = (
  side: "buy" | "sell",
  quantity: string,
  usdValue: string,
  instrument = "nvda",
  chain = "solana",
): PotFill => ({ chain, instrument, side, quantity, usdValue });

const free = (fills: PotFill[], inFlightBuysUsd: string[] = []) =>
  potOf({ potUsd: "100", fills, inFlightBuysUsd, sellSettling: false }).freeCashCents;

/** What it holds of each instrument, as whole units. */
const holds = (fills: PotFill[], sellSettling = false) =>
  Object.fromEntries(
    [...potOf({ potUsd: "100", fills, inFlightBuysUsd: [], sellSettling }).holds].map(
      ([key, quantity]) => [key, formatUnits(quantity, QUANTITY_DECIMALS)],
    ),
  );

describe("potOf free cash", () => {
  it("is the whole pot before anything is bought", () => {
    expect(free([])).toBe(10_000n);
  });

  it("takes out what holdings cost and what is still on its way", () => {
    expect(free([fill("buy", "2", "60")], ["25.50"])).toBe(1_450n);
  });

  it("takes out what its moves spent buying a chain's coin for their fees", () => {
    const pot = potOf({
      potUsd: "100",
      fills: [fill("buy", "2", "60")],
      inFlightBuysUsd: [],
      feesUsd: ["0.25", "3.00"],
      sellSettling: false,
    });
    expect(pot.freeCashCents).toBe(3_675n);
  });

  it("frees the whole pot when savings come out with their interest", () => {
    const aave = (side: "buy" | "sell", amount: string) =>
      fill(side, amount, amount, "ausdc", "monad");
    expect(free([aave("buy", "100"), aave("sell", "110")])).toBe(10_000n);
    expect(holds([aave("buy", "100"), aave("sell", "110")])).toEqual({});
  });

  it("gives back cost as holdings are sold, share for share", () => {
    expect(free([fill("buy", "4", "80"), fill("sell", "1", "20")])).toBe(4_000n);
  });

  it("keeps a gain out of reach until the pot is raised", () => {
    expect(free([fill("buy", "1", "100"), fill("sell", "1", "150")])).toBe(10_000n);
  });

  it("never refills a loss from other money", () => {
    expect(free([fill("buy", "1", "100"), fill("sell", "1", "40")])).toBe(4_000n);
    // A prediction that lost pays nothing when redeemed.
    expect(free([fill("buy", "200", "100"), fill("sell", "200", "0")])).toBe(0n);
  });

  it("nets gains and losses across holdings before counting a loss", () => {
    const fills = [
      fill("buy", "1", "50", "a"),
      fill("buy", "1", "50", "b"),
      fill("sell", "1", "70", "a"),
      fill("sell", "1", "40", "b"),
    ];
    expect(free(fills)).toBe(10_000n);
    expect(free([...fills.slice(0, 3), fill("sell", "1", "30", "b")])).toBe(10_000n);
    expect(free([...fills.slice(0, 3), fill("sell", "1", "10", "b")])).toBe(8_000n);
  });

  it("holds a short at its cost, never as cash that came in", () => {
    expect(free([fill("sell", "1", "30", "BTC", "hyperliquid")])).toBe(7_000n);
    // Closed for less than it opened at: a gain, so nothing more is spendable.
    expect(
      free([
        fill("sell", "1", "30", "BTC", "hyperliquid"),
        fill("buy", "1", "20", "BTC", "hyperliquid"),
      ]),
    ).toBe(10_000n);
    expect(
      free([
        fill("sell", "1", "30", "BTC", "hyperliquid"),
        fill("buy", "1", "45", "BTC", "hyperliquid"),
      ]),
    ).toBe(8_500n);
  });

  it("opens the other way with what is left of a fill past zero", () => {
    expect(
      free([
        fill("buy", "1", "40", "BTC", "hyperliquid"),
        fill("sell", "3", "150", "BTC", "hyperliquid"),
      ]),
    ).toBe(0n);
  });

  it("goes below zero when the pot is lowered under what is held", () => {
    const pot = potOf({
      potUsd: "50",
      fills: [fill("buy", "1", "80")],
      inFlightBuysUsd: [],
      sellSettling: false,
    });
    expect(pot.freeCashCents).toBe(-3_000n);
  });
});

describe("potOf holdings", () => {
  it("holds what it bought, less what it sold, until it has sold all of it", () => {
    expect(holds([fill("buy", "2", "60")])).toEqual({ "solana:nvda": "2" });
    expect(holds([fill("buy", "2", "60"), fill("sell", "0.75", "30")])).toEqual({
      "solana:nvda": "1.25",
    });
    expect(holds([fill("buy", "2", "60"), fill("sell", "2", "70")])).toEqual({});
  });

  it("holds nothing it sold past zero, unless it is a perp held short", () => {
    // Savings withdrawn with their interest take out more than went in.
    expect(
      holds([fill("buy", "100", "100", "0xa"), fill("sell", "100.5", "100.5", "0xa")]),
    ).toEqual({});
    expect(holds([fill("sell", "0.3", "30", "BTC", "hyperliquid")])).toEqual({
      "hyperliquid:btc": "0.3",
    });
  });

  it("holds nothing it can sell on its own while one of its sells is settling", () => {
    expect(holds([fill("buy", "2", "60")], true)).toEqual({});
  });
});

describe("potOf with a held sell", () => {
  const nvda = "solana:nvda";
  const sellable = (heldSales: [string, string][]) =>
    Object.fromEntries(
      [
        ...potOf({
          potUsd: "100",
          fills: [fill("buy", "4", "80"), fill("buy", "1", "10", "tsla")],
          inFlightBuysUsd: [],
          sellSettling: false,
          heldSales: new Map(heldSales.map(([key, units]) => [key, BigInt(units) * 10n ** 18n])),
        }).holds,
      ].map(([key, quantity]) => [key, formatUnits(quantity, QUANTITY_DECIMALS)]),
    );

  it("takes what the held sell may have sold out of what may be sold, and nothing else", () => {
    expect(sellable([[nvda, "1"]])).toEqual({ [nvda]: "3", "solana:tsla": "1" });
  });

  it("leaves none of a holding a held sell may have sold all of", () => {
    expect(sellable([[nvda, "4"]])).toEqual({ "solana:tsla": "1" });
    expect(sellable([[nvda, "9"]])).toEqual({ "solana:tsla": "1" });
  });
});
