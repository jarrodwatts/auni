import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions } from "../db/schema.ts";
import { insertAction } from "../test/db.ts";
import { recordActions } from "./actions.ts";
import type { Effect } from "./effect.ts";
import type { Recipe } from "./recipe.ts";
import { assertStepUp, needsStepUp, stepUpRefusal } from "./step-up.ts";

vi.mock("./recipes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recipeForTool: () => undefined,
}));

const EXCHANGE = "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2";
const OTHER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

/** A raw transaction whose simulation saw `effect`. */
const raw = (effect: Effect): Recipe => ({
  tool: "send_evm_transaction",
  description: "Sends a batch.",
  venue: "evm",
  input: {},
  about: () => null,
  describe: async () => ({ summary: "Send it", amountUsd: "5", effect }),
  execute: async () => ({ txs: [], fills: [] }),
});
const sendsTo = (to: string): Effect => ({
  gives: [{ text: "5 USDC" }],
  gets: [],
  grants: [],
  to: [to],
});

/** Records `effect` as a card waiting for the owner's tap, as proposeAction does. */
async function card(effect: Effect) {
  const recipe = raw(effect);
  const { rows } = await recordActions(
    { threadId: null },
    [{ recipe, input: {}, preview: await recipe.describe({} as never, {} as never) }],
    null,
  );
  return rows[0]!;
}

const reread = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0]!;

// The ladder's proof rung reaches every move whose money leaves the owner, not only a
// withdrawal: a raw transfer to a new address takes the owner's proof just the same.
describe("the proof rung", () => {
  it("keeps a card's lines and where its money goes, as its effect said them", async () => {
    const row = await card(sendsTo(EXCHANGE));
    expect(row.lines).toEqual([
      { label: "You send", value: "5 USDC" },
      { label: "To", value: EXCHANGE },
    ]);
    expect(row.details).toMatchObject({ leavesTo: EXCHANGE });
    expect(row.status).toBe("awaiting_permission");
  });

  it("takes the owner's proof for money leaving to somewhere new, and a tap once any done move went there", async () => {
    const row = await card(sendsTo(EXCHANGE));
    expect(await needsStepUp(row)).toBe(true);
    // A withdrawal there, done before, vouches for it, in any case.
    await insertAction({
      tool: "withdraw_usdc",
      status: "done",
      details: { leavesTo: EXCHANGE.toLowerCase() },
    });
    expect(await needsStepUp(row)).toBe(false);
    expect(await stepUpRefusal(row, false)).toBeNull();
  });

  it("takes the owner's proof for what its card pinned, wherever its money has gone before", async () => {
    const lets = {
      lets: "0x2222…2222 spend your USDC",
      reach: "wallet",
      exact: { kind: "spend", token: "0x1", to: "0x2" },
    } as const;
    const row = await card({ gives: [], gets: [], grants: [lets] });
    expect(row.details).toMatchObject({ needsStepUp: "lets 0x2222…2222 spend your USDC" });
    expect(await needsStepUp(row)).toBe(true);
  });

  it("asks no proof of a trade whose gets land in the wallet", async () => {
    const trade: Effect = { gives: [{ text: "5 USDC" }], gets: [{ text: "WETH" }], grants: [] };
    expect(await needsStepUp(await card(trade))).toBe(false);
  });
});

// The proof is the tap's own request (auth/proof.ts), which requireOwner judged as it let it in
// (auth/owner.db.test.ts drives that over HTTP).
describe("confirming a card on a tap that proves the owner is there", () => {
  it("refuses a tap that proves nothing, recording nothing", async () => {
    const row = await card(sendsTo(EXCHANGE));
    expect(await stepUpRefusal(row, false)).toBe("pair_again");
    expect((await reread(row.id)).stepUpAt).toBeNull();
  });

  it("allows the card, recording the proof execution checks", async () => {
    const row = await card(sendsTo(EXCHANGE));
    await expect(assertStepUp(row)).rejects.toThrow("so nothing was sent");
    expect(await stepUpRefusal(row, true)).toBeNull();
    const confirmed = await reread(row.id);
    expect(confirmed.stepUpAt).toBeInstanceOf(Date);
    await expect(assertStepUp(confirmed)).resolves.toBeUndefined();
    // A second tap after a lost answer goes through without the proof again.
    expect(await stepUpRefusal(confirmed, false)).toBeNull();
  });

  it("proves one action only: the next card is judged by the tap it gets", async () => {
    const mine = await card(sendsTo(EXCHANGE));
    const other = await card(sendsTo(OTHER));
    expect(await stepUpRefusal(mine, true)).toBeNull();
    expect((await reread(other.id)).stepUpAt).toBeNull();
    // The pairing has aged by the time the other card is tapped.
    expect(await stepUpRefusal(other, false)).toBe("pair_again");
    await expect(assertStepUp(await reread(other.id))).rejects.toThrow("so nothing was sent");
  });

  it("records nothing for an action that moved on before the tap", async () => {
    const row = await card(sendsTo(EXCHANGE));
    await db.update(actions).set({ status: "cancelled" }).where(eq(actions.id, row.id));
    await stepUpRefusal(row, true);
    expect((await reread(row.id)).stepUpAt).toBeNull();
  });
});
