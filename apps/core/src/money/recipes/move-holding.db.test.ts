import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { RETRACTED } from "@auni/shared";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../db/client.ts";
import { actions, specialists, fills, threads } from "../../db/schema.ts";
import { insertAction, insertSpecialist, insertThread, wipe } from "../../test/db.ts";
import { holdsToCard } from "../../test/held-to-card.ts";
import {
  decideActions,
  executeAction,
  prepareLegs,
  proposeAction,
  recordActions,
} from "../actions.ts";
import { APPROVED_SALE_OF } from "../approved.ts";
import { specialistActivity } from "../../specialists/specialists.ts";
import { fillIdentity } from "../fill-key.ts";
import type { Holding, Portfolio } from "../portfolio.ts";
import { lockCards } from "../pot.ts";
import type { Recipe } from "../recipe.ts";
import { SETTLING_MS } from "../readings.ts";
import { settleFromReceipts } from "../reconcile.ts";
import { moveHolding } from "./move-holding.ts";

// The live read is a stub: each test says what Other and each specialist hold.
const read = vi.hoisted(() => ({
  other: [] as Holding[],
  specialists: [] as { id: string; holdings: Holding[] }[],
}));
vi.mock("../portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPortfolio: async (): Promise<Partial<Portfolio>> => ({
    unavailable: [],
    looking: [],
    specialists: read.specialists.map((bucket) => ({
      ...bucket,
      purpose: "",
      status: "active",
      usdValue: "0.00",
      whole: true,
    })),
    other: { usdValue: "0.00", holdings: read.other },
  }),
}));
vi.mock("../holdings.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  holdingFaces: async (holdings: readonly Holding[]) => holdings.map(() => ({ name: "NVIDIA" })),
}));
vi.mock("../wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  signerFor: async () => ({}),
}));

const NVDA = "0x1f5A8a6f1D2B0c2b6D5c4e3F2a1B0c9D8e7F6a5B";
const OTHER = "0x0000000000000000000000000000000000000001";

function nvidia(quantity: string, usdValue: string): Holding {
  return {
    venue: "wallet",
    chain: "monad",
    instrument: NVDA,
    symbol: "NVDAx",
    quantity,
    decimals: 18,
    usdValue,
    cash: false,
    priceId: `monad:${NVDA}`,
  };
}

beforeEach(async () => {
  read.other = [];
  read.specialists = [];
  await wipe(specialists, actions, fills, threads);
});

const pot = async (id: string) =>
  (await db.select().from(specialists).where(eq(specialists.id, id)))[0]?.potUsd;

const movedFills = (actionId: string) =>
  db
    .select({
      specialistId: fills.specialistId,
      side: fills.side,
      quantity: fills.quantity,
      usdValue: fills.usdValue,
    })
    .from(fills)
    .where(eq(fills.actionId, actionId))
    .orderBy(asc(fills.side));

/** Asks from a chat, then the owner's tap, then the run. */
async function moveFromChat(input: Record<string, unknown>) {
  const thread = await insertThread();
  const asked = await proposeAction(
    { threadId: thread.id, specialistId: null },
    moveHolding,
    input,
  );
  await decideActions({ actionId: asked.action.id }, "allow");
  return { asked, done: await executeAction(asked.action.id) };
}

// A move re-files a holding in Auni's books and sends nothing, so it is held to its card by its
// records here, against a real database: it moves at the card's price, no more than the card
// showed however much arrived since, and nothing when less of a named amount is there.
holdsToCard("move_holding", {
  recordsOnly: "the tests below hold what it re-files to its card's quantity and price",
});

describe("move_holding", () => {
  it("moves a holding in Other into a specialist, filed there, without a trade or a fee", async () => {
    // Acting on its own changes nothing: a move always waits for the tap.
    const ai = await insertSpecialist({ potUsd: "100", actMode: "within_limits" });
    read.other = [nvidia("0.0232", "4.97")];

    const { asked, done } = await moveFromChat({
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
    });

    expect(asked.status).toBe("awaiting_permission");
    expect(asked.action.specialistId).toBe(ai.id);
    expect(asked.action.amountUsd).toBe("0.00");
    expect(done.status).toBe("done");
    expect(await movedFills(done.id)).toEqual([
      expect.objectContaining({ specialistId: ai.id, side: "buy", usdValue: "4.97" }),
      expect.objectContaining({ specialistId: null, side: "sell", usdValue: "4.97" }),
    ]);
    expect(await pot(ai.id)).toBe("104.97");
  });

  it("moves one specialist's holding to another, and each pot follows the money", async () => {
    const chips = await insertSpecialist({ name: "Chips", potUsd: "50" });
    const ai = await insertSpecialist({ potUsd: "100" });
    // Chips bought it, its books a crumb more than the wallet shows.
    const bought = await insertAction({ specialistId: chips.id, status: "done" });
    await db.insert(fills).values({
      actionId: bought.id,
      specialistId: chips.id,
      chain: "monad",
      instrument: NVDA,
      side: "buy",
      quantity: "0.02320000001",
      usdValue: "5.00",
    });
    await db
      .update(actions)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(actions.id, bought.id));
    read.specialists = [{ id: chips.id, holdings: [nvidia("0.0232", "4.97")] }];

    const { done } = await moveFromChat({
      chain: "monad",
      instrument: NVDA,
      from_specialist_id: chips.id,
      to_specialist_id: ai.id,
    });

    expect(done.status).toBe("done");
    expect(done.specialistId).toBe(ai.id);
    const [buy, sell] = await movedFills(done.id);
    expect(sell).toMatchObject({ specialistId: chips.id, quantity: "0.023200000010000000" });
    expect(buy).toMatchObject({ specialistId: ai.id, quantity: "0.023200000000000000" });
    expect(await pot(chips.id)).toBe("45.03");
    expect(await pot(ai.id)).toBe("104.97");
    // Both records show it: the one it left as much as the one it's filed under.
    expect((await specialistActivity(chips.id, 10)).map((row) => row.id)).toContain(done.id);
  });

  it("moves nothing while a move code can't name is still running", async () => {
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    await insertAction({ specialistId: null, status: "running", tool: "stock_trade" });

    const { done } = await moveFromChat({
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
    });

    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/still running/u);
    expect(await movedFills(done.id)).toEqual([]);
    expect(await pot(ai.id)).toBe("100.00");
  });

  it("waits out a trade of it that just settled, rather than fail the tap", async () => {
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    // The buy that brought it here settled long enough ago that a read shows it in 300 ms.
    await insertAction({
      status: "done",
      input: { side: "buy" },
      details: { chain: "monad", mint: NVDA },
      updatedAt: new Date(Date.now() - SETTLING_MS + 300),
    });

    const started = Date.now();
    const { done } = await moveFromChat({
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
    });

    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await pot(ai.id)).toBe("104.97");
  });

  it("declines every plan still waiting to sell it, wherever it waits, and leaves others be", async () => {
    const chips = await insertSpecialist({ name: "Chips" });
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    const thread = await insertThread();
    const asked = await proposeAction({ threadId: thread.id, specialistId: null }, moveHolding, {
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
    });
    // Asked for in another thread, after the move's card, so the move's doesn't replace them.
    const elsewhere = await insertThread();
    const sells = (instrument: string) => ({
      [APPROVED_SALE_OF]: fillIdentity({ chain: "monad", instrument }),
    });
    // A swap of it for another token, in another specialist: the card is about what it buys.
    const swap = await insertAction({
      threadId: elsewhere.id,
      specialistId: chips.id,
      status: "awaiting_permission",
      tool: "evm_swap",
      input: { chain: "monad", sellToken: NVDA, buyToken: OTHER },
      details: { chain: "monad", mint: OTHER, ...sells(NVDA) },
    });
    const other = await insertAction({
      threadId: elsewhere.id,
      status: "awaiting_permission",
      details: sells(OTHER),
    });
    // A raw transaction, known by what its simulation showed it sending.
    const raw = (sends: string | null, chain = "monad") =>
      insertAction({
        threadId: elsewhere.id,
        status: "awaiting_permission",
        tool: "send_evm_transaction",
        input: { chain },
        details: sends === null ? {} : { sendsUpTo: sends, getsAbout: "" },
      });
    const sendsIt = await raw(`${NVDA}:1000`);
    const sendsOther = await raw(`${OTHER}:1000`);
    // Drawn without a simulation, it could send anything on its chain, and nothing on another.
    const unknown = await raw(null);
    const unknownElsewhere = await raw(null, "base");
    // A card that names no sale: known by what it's about.
    const unnamed = await insertAction({
      threadId: elsewhere.id,
      status: "awaiting_permission",
      input: { side: "sell" },
      details: { chain: "monad", mint: NVDA },
    });
    const unnamedBuy = await insertAction({
      threadId: elsewhere.id,
      status: "awaiting_permission",
      input: { side: "buy" },
      details: { chain: "monad", mint: NVDA },
    });
    // A plan that sells it to buy something else goes whole, not just its sale.
    const plan = {
      threadId: elsewhere.id,
      proposalId: randomUUID(),
      status: "awaiting_permission" as const,
    };
    const planSale = await insertAction({ ...plan, details: sells(NVDA) });
    const planBuy = await insertAction({ ...plan, input: { side: "buy" } });
    await decideActions({ actionId: asked.action.id }, "allow");
    expect((await executeAction(asked.action.id)).status).toBe("done");

    const status = async (id: string) =>
      (await db.select().from(actions).where(eq(actions.id, id)))[0]?.status;
    // Taken back by Auni, never declined in the owner's name, and each card says why.
    for (const { id } of [swap, planSale, planBuy, unnamed, sendsIt, unknown])
      expect((await db.select().from(actions).where(eq(actions.id, id)))[0]).toMatchObject({
        status: "retracted",
        error: RETRACTED.moved,
      });
    expect(await status(sendsOther.id)).toBe("awaiting_permission");
    expect(await status(unknownElsewhere.id)).toBe("awaiting_permission");
    expect(await status(other.id)).toBe("awaiting_permission");
    expect(await status(unnamedBuy.id)).toBe("awaiting_permission");
  });

  it("moves nothing while a swap selling it for another token is still running", async () => {
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    // About what it buys, so only what it sells ties it to this holding.
    await insertAction({
      status: "running",
      tool: "evm_swap",
      input: { chain: "monad", sellToken: NVDA, buyToken: OTHER },
      details: {
        chain: "monad",
        mint: OTHER,
        [APPROVED_SALE_OF]: fillIdentity({ chain: "monad", instrument: NVDA }),
      },
    });

    const { done } = await moveFromChat({
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
    });

    expect(done.status).toBe("failed");
    expect(await movedFills(done.id)).toEqual([]);
  });

  it("moves at the price its card showed, so the pot rises by no more than it said", async () => {
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    const thread = await insertThread();
    const asked = await proposeAction({ threadId: thread.id, specialistId: null }, moveHolding, {
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
    });
    // The price doubles before the tap.
    read.other = [nvidia("0.0232", "9.94")];
    await decideActions({ actionId: asked.action.id }, "allow");
    const done = await executeAction(asked.action.id);

    expect(done.status).toBe("done");
    expect((await movedFills(done.id)).map((fill) => fill.usdValue)).toEqual(["4.97", "4.97"]);
    expect(await pot(ai.id)).toBe("104.97");
  });

  it("moves nothing when less of a named amount is there than the card showed", async () => {
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    const thread = await insertThread();
    const asked = await proposeAction({ threadId: thread.id, specialistId: null }, moveHolding, {
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
      quantity: "0.02",
    });
    read.other = [nvidia("0.01", "2.14")];
    await decideActions({ actionId: asked.action.id }, "allow");
    const done = await executeAction(asked.action.id);

    expect(done.status).toBe("failed");
    expect(await movedFills(done.id)).toEqual([]);
    expect(await pot(ai.id)).toBe("100.00");
  });

  it("records no card while a move holds the owner's cards", async () => {
    let release = () => {};
    let locked = () => {};
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const moving = db.transaction(async (tx) => {
      await lockCards(tx);
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    const sell = {
      recipe: { ...moveHolding, tool: "stock_trade" } as Recipe,
      input: {},
      preview: {
        summary: "Sell NVIDIA",
        amountUsd: "0",
        effect: { gives: [{ text: "NVDAx" }], gets: [{ text: "USDC" }], grants: [] },
      },
    };
    const recorded = recordActions({ threadId: null, specialistId: null }, [sell], null);
    const first = await Promise.race([
      recorded.then(() => "recorded"),
      sleep(200).then(() => "waited"),
    ]);
    release();
    await Promise.all([moving, recorded]);
    expect(first).toBe("waited");
  });

  it("waits only on a running raw transaction that moves it, not one elsewhere", async () => {
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    const running = (chain: string, details: Record<string, string>) =>
      insertAction({
        status: "running",
        tool: "send_evm_transaction",
        input: { chain },
        details,
      });
    // On Base, and on Monad sending something else: neither can change it.
    await running("base", {});
    const other = await running("monad", { sendsUpTo: `${OTHER}:1`, getsAbout: "" });
    const move = { chain: "monad", instrument: NVDA, to_specialist_id: ai.id };
    expect((await moveFromChat(move)).done.status).toBe("done");

    // On Monad, getting it: the read can't be trusted until that lands.
    await db.update(actions).set({ status: "done", phase: null }).where(eq(actions.id, other.id));
    await running("monad", { sendsUpTo: `${OTHER}:1`, getsAbout: `${NVDA}:1` });
    expect((await moveFromChat(move)).done.status).toBe("failed");
  });

  it("records which holding a sell card sells, so a move can find it", async () => {
    const sell = {
      recipe: { ...moveHolding, tool: "stock_trade" } as Recipe,
      input: {},
      preview: {
        summary: "Sell NVIDIA",
        amountUsd: "0",
        effect: { gives: [{ text: "NVDAx" }], gets: [{ text: "USDC" }], grants: [] },
        sells: { chain: "monad" as const, instrument: NVDA, quantity: "0.0232" },
      },
    };
    const { rows } = await recordActions({ threadId: null, specialistId: null }, [sell], null);
    expect(rows[0]?.details[APPROVED_SALE_OF]).toBe(
      fillIdentity({ chain: "monad", instrument: NVDA }),
    );
  });

  it("fails a move left running with nothing recorded, which moved nothing", async () => {
    const stuck = await insertAction({
      tool: moveHolding.tool,
      amountUsd: "0",
      startedAt: new Date(Date.now() - 60 * 60_000),
    });
    expect((await settleFromReceipts(stuck))?.status).toBe("failed");
  });

  it("never moves more than its card showed, even when more has arrived since", async () => {
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    const thread = await insertThread();
    const asked = await proposeAction({ threadId: thread.id, specialistId: null }, moveHolding, {
      chain: "monad",
      instrument: NVDA,
      to_specialist_id: ai.id,
    });
    read.other = [nvidia("0.0464", "9.94")];
    await decideActions({ actionId: asked.action.id }, "allow");
    const done = await executeAction(asked.action.id);

    expect(done.status).toBe("done");
    expect((await movedFills(done.id)).map((fill) => fill.quantity)).toEqual([
      "0.023200000000000000",
      "0.023200000000000000",
    ]);
    expect(await pot(ai.id)).toBe("104.97");
  });

  it("refuses a retired specialist, more than is held, and a leg of another card", async () => {
    const retired = await insertSpecialist({ status: "retired" });
    const ai = await insertSpecialist();
    read.other = [nvidia("0.0232", "4.97")];
    const context = { threadId: null, specialistId: null };
    const move = { chain: "monad", instrument: NVDA };

    await expect(
      proposeAction(context, moveHolding, { ...move, to_specialist_id: retired.id }),
    ).rejects.toThrow(/retired/u);
    await expect(
      proposeAction(context, moveHolding, { ...move, to_specialist_id: ai.id, quantity: "1" }),
    ).rejects.toThrow(/holds only/u);
    const { problems } = await prepareLegs(
      [{ tool: moveHolding.tool, input: { ...move, to_specialist_id: ai.id }, label: "move" }],
      context,
    );
    expect(problems).toEqual([expect.stringMatching(/its own card/u)]);
  });
});
