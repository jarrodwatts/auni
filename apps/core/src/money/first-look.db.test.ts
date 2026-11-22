import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";
import { actions, fills, firstLooks, otherTokens } from "../db/schema.ts";
import { insertAction, wipe } from "../test/db.ts";
import { countFirstLook, placeOf } from "./first-look.ts";
import { madeUsd, walletFlows } from "./made.ts";
import type { Holding } from "./portfolio.ts";

// What an app's account holds when Auni first reads it, as the portfolio reads it: a perps
// account's position and its cash, a prediction market's shares. Any app's account goes through
// the same door, so these stand for one Auni has never heard of.

beforeEach(() => wipe(actions, fills, firstLooks, otherTokens));

const holding = (fields: Partial<Holding>): Holding => ({
  venue: "hyperliquid",
  chain: "hyperliquid",
  instrument: "ETH",
  symbol: "ETH",
  quantity: "0.01",
  decimals: 18,
  usdValue: "3.00",
  cash: false,
  priceId: null,
  ...fields,
});
const POSITION = holding({});
const CASH = holding({ instrument: "USDC", symbol: "USDC", usdValue: "5.00", cash: true });
/** Cash at the account that an order still waiting holds: the owner's cash, not free yet. */
const HELD = { ...CASH, usdValue: "1.50", heldForOrders: true } as const;
const SHARES = holding({
  venue: "polymarket",
  chain: "polygon",
  instrument: "1116621296528282668893603744686571514795",
  usdValue: "0.97",
});
const PLACES = [placeOf("hyperliquid", "hyperliquid"), placeOf("polymarket", "polygon")];

/** What money made at these holdings' worth, their plain cash `cash`. */
async function made(held: readonly Holding[], cash = 0) {
  const value = held.reduce((sum, { usdValue }) => sum + Number(usdValue), 0);
  return madeUsd(value, cash, await walletFlows());
}

describe("an app's account at Auni's first look", () => {
  it("counts all it holds as money put in, but its plain cash, so nothing reads as made", async () => {
    await countFirstLook([POSITION, CASH, SHARES], PLACES, new Set());
    expect(await made([POSITION, CASH, SHARES], 5)).toBe("0.00");
    expect((await walletFlows()).map(({ key, usd }) => [key, usd]).toSorted()).toEqual([
      ["hyperliquid:eth", 3],
      ["polygon:1116621296528282668893603744686571514795", 0.97],
    ]);
    // Looked at again, nothing is put in twice.
    await countFirstLook([POSITION, CASH, SHARES], PLACES, new Set());
    expect(await made([POSITION, CASH, SHARES], 5)).toBe("0.00");
  });

  it("counts the cash an order holds there as cash, as every total does, never as put in", async () => {
    await countFirstLook([POSITION, CASH, HELD], PLACES, new Set());
    expect((await walletFlows()).map(({ key }) => key)).toEqual(["hyperliquid:eth"]);
    expect(await made([POSITION, CASH, HELD], 6.5)).toBe("0.00");
  });

  it("counts nothing that turns up there later: a trade brought it, which its fills count", async () => {
    await countFirstLook([CASH], PLACES, new Set());
    // Auni opens the position with $3 of the account's cash; its statement hasn't shown the
    // fill yet when the next read finds it.
    const position = holding({ usdValue: "3.00" });
    const cash = holding({ instrument: "USDC", usdValue: "2.00", cash: true });
    await countFirstLook([position, cash], PLACES, new Set());
    const action = await insertAction({ status: "done" });
    await db.insert(fills).values({
      actionId: action.id,
      chain: "hyperliquid",
      instrument: "ETH",
      side: "buy",
      quantity: "0.01",
      usdValue: "3.00",
    });
    expect(await made([position, cash], 2)).toBe("0.00");
  });

  it("counts nothing Auni has a fill of, where it traded before it ever read the account", async () => {
    await countFirstLook([POSITION], PLACES, new Set(["hyperliquid:eth"]));
    expect(await walletFlows()).toEqual([]);
  });

  it("waits for a read that can value what it holds, lest its worth read as made", async () => {
    await countFirstLook([{ ...SHARES, usdValue: null }], PLACES, new Set());
    expect(await walletFlows()).toEqual([]);
    await countFirstLook([SHARES], PLACES, new Set());
    expect((await walletFlows()).map(({ usd }) => usd)).toEqual([0.97]);
  });
});
