import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, fills, threads } from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { FACE, stubRecipe } from "../test/recipe.ts";
import type { Recipe } from "./recipe.ts";
import { markCrashed } from "./record.ts";
import { quoteAgain, retryAction, retryProposal } from "./retry.ts";

// A move that gets cash to Solana first, and a pick that spends it there: their stages are the
// only thing about them these tests read.
const RECIPES: Record<string, Recipe> = {
  bridge_usdc: stubRecipe({
    tool: "bridge_usdc",
    readies: () => "solana",
    fundedFrom: () => "monad",
  }),
  stock_trade: stubRecipe({ fundedFrom: () => "solana" }),
  // A buy that prices as its card says: $50 of Nvidia at $184.20 a share.
  evm_swap: stubRecipe({
    tool: "evm_swap",
    describe: async () => ({
      summary: "Buy $50.00 of Nvidia",
      amountUsd: "50.00",
      effect: { gives: [], gets: [], grants: [] },
      card: { ...FACE, price: "$184.20" },
    }),
  }),
};
vi.mock("./recipes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recipeForTool: (tool: string) => RECIPES[tool],
}));
const cash = vi.hoisted(() => ({ short: null as string | null }));
vi.mock("./funding.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  unpaid: async () => cash.short,
}));

beforeEach(async () => {
  cash.short = null;
  await wipe(threads, actions, fills);
});

/** The moves queued to run, by action id. */
const started = async () => (await queued("action")).map(({ data }) => data.actionId);

const actionRow = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0]!;

const blipped = { status: "failed", error: "fetch failed", failureKind: "glitch" } as const;

describe("retryAction", () => {
  it("runs a failed step again once however many taps reach it at the same time", async () => {
    const row = await insertAction(blipped);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => retryAction(row, 1)));
    expect(outcomes.filter((each) => each.kind === "running")).toHaveLength(1);
    expect(outcomes.filter((each) => each.kind === "moved_on")).toHaveLength(4);
    expect(await started()).toEqual([row.id]);
    expect(await actionRow(row.id)).toMatchObject({
      status: "running",
      phase: "queued",
      startedAt: null,
      error: null,
      failureKind: null,
      attempts: 2,
      previousErrors: [{ error: "fetch failed", kind: "glitch" }],
    });
  });

  it("refuses a tap from a screen that saw an earlier run fail", async () => {
    const row = await insertAction({ ...blipped, attempts: 2 });
    expect(await retryAction(row, 1)).toEqual({ kind: "moved_on" });
    expect(await actionRow(row.id)).toMatchObject({ status: "failed", attempts: 2 });
    expect(await started()).toEqual([]);
  });

  it("refuses one that sent the move itself, or recorded what it traded", async () => {
    const sent = await insertAction({
      ...blipped,
      txs: [{ chain: "base", hash: "0xabc" }],
    });
    expect(await retryAction(sent, 1)).toEqual({ kind: "refused", reason: "not_retryable" });
    // Fills are only in the database, so the update itself refuses it.
    const traded = await insertAction(blipped);
    await db.insert(fills).values({
      actionId: traded.id,
      instrument: "nvda",
      chain: "base",
      side: "buy",
      quantity: "1",
      usdValue: "10",
    });
    expect(await retryAction(traded, 1)).toEqual({ kind: "moved_on" });
    expect(await actionRow(traded.id)).toMatchObject({ status: "failed", attempts: 1 });
    // So is a send kept since the screen read the row.
    const behind = await insertAction(blipped);
    await db
      .update(actions)
      .set({ txs: [{ chain: "base", hash: "0xdef" }] })
      .where(eq(actions.id, behind.id));
    expect(await retryAction(behind, 1)).toEqual({ kind: "moved_on" });
    expect(await actionRow(behind.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(await started()).toEqual([]);
  });

  it("runs one again whose only send was its setup", async () => {
    const row = await insertAction({
      ...blipped,
      txs: [{ chain: "base", hash: "0xapprove", setup: true }],
    });
    expect(await retryAction(row, 1)).toEqual({ kind: "running" });
  });

  // A Hyperliquid order keeps no send, and its fills show only once a statement is read, so a
  // run that died after placing it looks like one that sent nothing.
  it("refuses a run that died partway, whose outcome no one knows", async () => {
    const { id } = await insertAction({ tool: "hyperliquid_order", phase: "sending" });
    const crashed = await markCrashed(id);
    expect(crashed).toMatchObject({ status: "failed" });
    expect(await retryAction(crashed, 1)).toEqual({
      kind: "refused",
      reason: "not_retryable",
    });
    expect(await started()).toEqual([]);
  });

  it("refuses one whose price is past what was approved now, which takes new terms", async () => {
    const row = await insertAction({ ...blipped, failureKind: "price" });
    expect(await retryAction(row, 1)).toEqual({ kind: "refused", reason: "not_retryable" });
    expect(await started()).toEqual([]);
  });

  it("refuses money leaving the person, which the owner's proof vouched for once", async () => {
    const row = await insertAction({ ...blipped, details: { leavesTo: "0xabc" } });
    expect(await retryAction(row, 1)).toEqual({ kind: "refused", reason: "needs_proof" });
    expect(await actionRow(row.id)).toMatchObject({ status: "failed" });
  });

  it("refuses what running again can't fix, a leg on its own, and an archived thread's move", async () => {
    const short = await insertAction({ ...blipped, failureKind: "funds" });
    expect(await retryAction(short, 1)).toEqual({ kind: "refused", reason: "not_retryable" });
    const leg = await insertAction({ ...blipped, proposalId: randomUUID() });
    expect(await retryAction(leg, 1)).toEqual({ kind: "refused", reason: "not_retryable" });
    const archived = await insertThread({ archivedAt: new Date() });
    const late = await insertAction({ ...blipped, threadId: archived.id });
    expect(await retryAction(late, 1)).toEqual({ kind: "moved_on" });
    expect(await started()).toEqual([]);
  });

  it("refuses one whose cash isn't there now, changing nothing", async () => {
    const row = await insertAction(blipped);
    cash.short = "Solana is $5 short";
    expect(await retryAction(row, 1)).toEqual({
      kind: "refused",
      reason: "short_of_money",
    });
    expect(await actionRow(row.id)).toMatchObject({ status: "failed", attempts: 1 });
  });
});

describe("quoteAgain", () => {
  it("prices the move afresh, with one unit's price in its card's own words", async () => {
    const row = await insertAction({ ...blipped, failureKind: "price", tool: "evm_swap" });
    expect(await quoteAgain(row)).toMatchObject({ amountUsd: "50.00", price: "$184.20" });
  });

  it("says no price for a move whose card says none", async () => {
    RECIPES.bridge_usdc!.describe = async () => ({
      summary: "Move $50.00 to Solana",
      amountUsd: "50.00",
      effect: { gives: [], gets: [], grants: [] },
    });
    const row = await insertAction({ ...blipped, failureKind: "price", tool: "bridge_usdc" });
    expect(await quoteAgain(row)).toMatchObject({ price: null });
  });
});

describe("retryProposal", () => {
  async function card() {
    const proposalId = randomUUID();
    const leg = (tool: string, fields: Partial<typeof actions.$inferInsert>) =>
      insertAction({ proposalId, tool, input: {}, ...fields });
    return {
      proposalId,
      bridge: await leg("bridge_usdc", blipped),
      picks: [
        await leg("stock_trade", { status: "failed", failureKind: "stopped" }),
        await leg("stock_trade", { status: "failed", failureKind: "stopped" }),
      ],
    };
  }

  it("runs the move that blipped again with the picks it stopped, from where it stopped", async () => {
    const { proposalId, bridge, picks } = await card();
    expect(await retryProposal(proposalId, 3)).toEqual({ kind: "running" });
    for (const each of [bridge, ...picks])
      expect(await actionRow(each.id)).toMatchObject({
        status: "running",
        startedAt: null,
        attempts: 2,
      });
    // Only the move starts; its picks start once it lands.
    expect(await started()).toEqual([bridge.id]);
  });

  it("runs a card again once however many taps reach it", async () => {
    const { proposalId } = await card();
    const outcomes = await Promise.all([1, 2, 3].map(() => retryProposal(proposalId, 3)));
    expect(outcomes.filter((each) => each?.kind === "running")).toHaveLength(1);
    expect(await started()).toHaveLength(1);
    // A screen that saw the first run fail is behind once it ran again.
    expect(await retryProposal(proposalId, 3)).toEqual({ kind: "moved_on" });
  });

  it("leaves picks stopped behind a move that can't go again", async () => {
    const { proposalId } = await card();
    await db.update(actions).set({ failureKind: "funds" }).where(eq(actions.tool, "bridge_usdc"));
    expect(await retryProposal(proposalId, 3)).toEqual({
      kind: "refused",
      reason: "not_retryable",
    });
  });

  // Nothing here can be priced again, so a moved price reads as still past what was approved.
  it("leaves a pick whose price moved past what was approved, running the rest", async () => {
    const proposalId = randomUUID();
    const pick = (fields: Partial<typeof actions.$inferInsert>) =>
      insertAction({ proposalId, tool: "stock_trade", input: {}, ...fields });
    const blip = await pick(blipped);
    const moved = await pick({ status: "failed", error: "Price moved", failureKind: "price" });
    expect(await retryProposal(proposalId, 2)).toEqual({ kind: "running" });
    expect(await actionRow(blip.id)).toMatchObject({ status: "running", attempts: 2 });
    expect(await actionRow(moved.id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("finds no card to run again for a proposal there is none of", async () => {
    expect(await retryProposal(randomUUID(), 3)).toBeNull();
  });
});
