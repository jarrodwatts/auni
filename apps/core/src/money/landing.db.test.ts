import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, fills, jobs, specialists } from "../db/schema.ts";
import { landingJob } from "../jobs/action.ts";
import { insertAction, insertSpecialist, wipe } from "../test/db.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import { specialistPot } from "./pot.ts";
import type { Fill } from "./recipe.ts";
import { finish, LANDING_WINDOW_MS } from "./record.ts";
import { parseUnits } from "./usd.ts";

// What Across says of the deposit when asked whether it landed is the test's.
const across = vi.hoisted(() => ({ status: "pending" }));
vi.mock("./wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmAddress: async () => "0x2222222222222222222222222222222222222222",
}));

const WETH: Fill = {
  chain: "ethereum",
  instrument: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  side: "buy",
  quantity: "0.003",
  usdValue: "10",
};

beforeEach(async () => {
  across.status = "pending";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("deposit/status")) throw new Error(`Unexpected fetch of ${url}`);
      return Response.json({
        status: across.status,
        fillTxnRef: across.status === "filled" ? "0xfill" : null,
        depositRefundTxnRef: across.status === "refunded" ? "0xrefund" : null,
      });
    }),
  );
  await wipe(specialists, actions, fills, jobs);
});
afterEach(() => vi.unstubAllGlobals());

const run = (actionId: string) =>
  landingJob.run(
    { actionId },
    { id: "landing", createdAt: new Date(), attempts: 1, signal: new AbortController().signal },
  );

const fillsOf = (actionId: string) =>
  db
    .select({
      specialistId: fills.specialistId,
      side: fills.side,
      quantity: fills.quantity,
      usdValue: fills.usdValue,
    })
    .from(fills)
    .where(eq(fills.actionId, actionId));

/** $10 of cash on Monad sent `ago` milliseconds ago to buy WETH on Ethereum, still on its way. */
const buyingWeth = (specialistId: string | null, ago = 0) =>
  insertAction({
    tool: "bridge_usdc",
    venue: "across",
    specialistId,
    input: { from_chain: "monad", to_chain: "1", amount: "10", output_token: WETH.instrument },
    phase: "landing",
    startedAt: new Date(Date.now() - ago),
    txs: [{ chain: "monad", hash: "0xdeposit" }],
    run: {
      lands: "about 0.003 WETH on Ethereum",
      arrivesChain: WETH.chain,
      arrivesToken: WETH.instrument,
      arrivesQuantity: WETH.quantity,
    },
  });

describe("a bridge that buys where it lands", () => {
  it("records what it bought once Across fills it, under its specialist, and only once", async () => {
    const ai = await insertSpecialist();
    const action = await buyingWeth(ai.id);
    expect(await run(action.id)).toEqual({ again: 10_000 });
    expect(await fillsOf(action.id)).toEqual([]);
    across.status = "filled";
    expect(await run(action.id)).toBeUndefined();
    const [row] = await db.select().from(actions).where(eq(actions.id, action.id));
    expect(row).toMatchObject({ status: "done", error: null, run: { delivered: "0xfill" } });
    const bought = [
      { specialistId: ai.id, side: "buy", quantity: "0.003000000000000000", usdValue: "10.00" },
    ];
    expect(await fillsOf(action.id)).toEqual(bought);
    // Watched again, or finished again after a write that landed unacknowledged: nothing more.
    await run(action.id);
    await finish(action.id, undefined, "0xfill", [WETH]);
    expect(await fillsOf(action.id)).toEqual(bought);
  });

  it("gives what it bought to whoever its own sale was written to, in the same shares", async () => {
    const [ai, energy] = [await insertSpecialist(), await insertSpecialist()];
    const action = await buyingWeth(ai.id);
    await db.update(actions).set({ amountUsd: "9" }).where(eq(actions.id, action.id));
    const sale = {
      actionId: action.id,
      chain: "monad",
      instrument: "0xtoken",
      side: "sell" as const,
    };
    await db.insert(fills).values([
      { ...sale, specialistId: ai.id, quantity: "2", usdValue: "6" },
      { ...sale, specialistId: energy.id, quantity: "1", usdValue: "3" },
    ]);
    across.status = "filled";
    await run(action.id);
    const bought = (await fillsOf(action.id)).filter((fill) => fill.side === "buy");
    expect(bought).toHaveLength(2);
    expect(bought).toEqual(
      expect.arrayContaining([
        { specialistId: ai.id, side: "buy", quantity: "0.002000000000000000", usdValue: "6.00" },
        {
          specialistId: energy.id,
          side: "buy",
          quantity: "0.001000000000000000",
          usdValue: "3.00",
        },
      ]),
    );
  });

  it("buys nothing when Across refunds it, saying where it went back", async () => {
    const action = await buyingWeth(null);
    across.status = "refunded";
    await run(action.id);
    const [row] = await db.select().from(actions).where(eq(actions.id, action.id));
    expect(row).toMatchObject({
      status: "done",
      error: "Across couldn't deliver it, so it went back to Monad.",
      run: { delivered: "0xrefund" },
    });
    expect(await fillsOf(action.id)).toEqual([]);
  });

  it("keeps watching, less often, until the landing window passes, then finishes saying so", async () => {
    const hour = 60 * 60_000;
    const slow = await buyingWeth(null, 11 * hour);
    expect(await run(slow.id)).toEqual({ again: 5 * 60_000 });
    expect((await db.select().from(actions).where(eq(actions.id, slow.id)))[0]?.status).toBe(
      "running",
    );
    const lost = await buyingWeth(null, LANDING_WINDOW_MS + 60_000);
    expect(await run(lost.id)).toBeUndefined();
    const [row] = await db.select().from(actions).where(eq(actions.id, lost.id));
    expect(row?.status).toBe("done");
    expect(row?.error).toMatch(/^It hasn't shown up as about 0.003 WETH on Ethereum yet/);
    expect(await fillsOf(lost.id)).toEqual([]);
  });

  it("counts a buy on its way as spoken for, then as held, never as free cash between", async () => {
    const ai = await insertSpecialist({ potUsd: "100" });
    const action = await buyingWeth(ai.id);
    const pot = () => db.transaction((tx) => specialistPot(tx, ai));
    const before = await pot();
    expect(before.freeCashCents).toBe(9_000n);
    expect(before.holds.get(fillIdentity(WETH))).toBeUndefined();
    across.status = "filled";
    await run(action.id);
    const after = await pot();
    expect(after.freeCashCents).toBe(9_000n);
    expect(after.holds.get(fillIdentity(WETH))).toBe(parseUnits("0.003", QUANTITY_DECIMALS));
  });
});
