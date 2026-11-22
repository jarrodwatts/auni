import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";
import { actions, arrivals, specialists, fills } from "../db/schema.ts";
import { insertAction, insertSpecialist, wipe } from "../test/db.ts";
import { explainedHoldings } from "./pay-with-holdings.ts";

beforeEach(() => wipe(specialists, actions, fills, arrivals));

const LINK = "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196";
const whole = (units: string) => BigInt(units) * 10n ** 18n;

describe("explainedHoldings", () => {
  it("counts what came in as priced deposits, and every loose buy of Auni's, which no sale cancels", async () => {
    const ai = await insertSpecialist();
    const arrived = (kind: "deposit" | "landing", usdValue: string | null, index: number) => ({
      chain: "base",
      txHash: `0x${index}`,
      position: "log:0",
      instrument: LINK,
      baseUnits: String(whole("2")),
      decimals: 18,
      usdValue,
      kind,
      at: new Date(),
      block: 1,
    });
    // Two priced deposits count; a landing of a move, and a token no one prices, don't.
    await db
      .insert(arrivals)
      .values([
        arrived("deposit", "30.00", 0),
        arrived("deposit", "30.00", 1),
        arrived("landing", "30.00", 2),
        arrived("deposit", null, 3),
      ]);
    const fill = (
      actionId: string,
      specialistId: string | null,
      side: "buy" | "sell",
      quantity: string,
    ) => ({
      actionId,
      specialistId,
      chain: "base",
      instrument: LINK,
      side,
      quantity,
      usdValue: "15",
    });
    const loose = await insertAction({ status: "done", tool: "evm_swap" });
    const forAi = await insertAction({ status: "done", tool: "evm_swap" });
    const converted = await insertAction({ status: "done", tool: "convert_to_cash" });
    await db
      .insert(fills)
      .values([
        fill(loose.id, null, "buy", "3"),
        fill(loose.id, null, "sell", "1"),
        fill(forAi.id, ai.id, "buy", "5"),
        fill(converted.id, null, "sell", "4"),
      ]);
    const { bought, deposited } = await explainedHoldings();
    // A sale before a buy, or a move of it into a specialist, leaves the buy meant to stay.
    expect(bought).toEqual(new Map([[`base:${LINK.toLowerCase()}`, whole("3")]]));
    expect(deposited).toEqual(new Map([[`base:${LINK.toLowerCase()}`, whole("4")]]));
  });
});
