import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";
import { actions, specialists, fills } from "../db/schema.ts";
import { insertAction, insertSpecialist, wipe } from "../test/db.ts";
import { settledOutcome } from "./actions.ts";
import { APPROVED_SALE_OF } from "./approved.ts";
import { QUANTITY_DECIMALS } from "./fill-key.ts";
import {
  finish,
  keepTxsSafely,
  markFailed,
  markStopped,
  onTheirWay,
  recordResult,
} from "./record.ts";
import { moneyOf } from "./recipe.ts";
import { parseUnits } from "./usd.ts";

beforeEach(() => wipe(specialists, actions, fills));

// Settled long enough ago that a read of the wallet shows it.
const settledLongAgo = (id: string) =>
  db
    .update(actions)
    .set({ status: "done", phase: null, updatedAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(actions.id, id));

const actionRow = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0];

describe("finish", () => {
  it("keeps the transaction that delivered a move beside what its run already noted", async () => {
    const bridge = await insertAction({ phase: "landing", run: { lands: "$5.00 on Base" } });
    expect(await finish(bridge.id, undefined, "0xfill")).toMatchObject({
      status: "done",
      phase: null,
      run: { lands: "$5.00 on Base", delivered: "0xfill" },
    });
  });
});

describe("onTheirWay", () => {
  // A move still sending, or unsure, has money that may not have left: counting it as on its way
  // would add it to the total beside the balance that still holds it.
  it("counts only a move that was sent and lands later", async () => {
    const moves = await Promise.all(
      (["queued", "sending", "landing", "unsure"] as const).map((phase) =>
        insertAction({ tool: "withdraw_usdc", phase, run: { lands: `$5.00, ${phase}` } }),
      ),
    );
    expect(await onTheirWay()).toEqual([
      { actionId: moves[2]!.id, lands: "$5.00, landing", usdValue: "10.00" },
    ]);
  });
});

describe("markStopped", () => {
  it("fails a run that sent nothing, and keeps one that sent anything running for its receipts", async () => {
    const unsent = await insertAction({ phase: "sending" });
    const sent = await insertAction({
      phase: "sending",
      txs: [{ chain: "base", walletTxId: "p1" }],
    });
    expect(await markStopped(unsent.id, "quote expired", "unknown")).toMatchObject({
      status: "failed",
      error: "quote expired",
      failureKind: "unknown",
    });
    expect(await markStopped(sent.id, "socket hang up", "glitch")).toMatchObject({
      status: "running",
      phase: "unsure",
      error: "socket hang up",
      failureKind: "glitch",
    });
  });

  it("keeps a send that got no answer in the write that stops the run, so it stays running", async () => {
    const { id } = await insertAction({ phase: "sending" });
    expect(await markStopped(id, "no answer", "glitch", { chain: "solana" })).toMatchObject({
      status: "running",
      phase: "unsure",
      txs: [{ chain: "solana" }],
    });
  });

  it("leaves an action that already settled as it was", async () => {
    const { id } = await insertAction({ status: "done" });
    const before = await actionRow(id);
    expect(await markStopped(id, "late error", "unknown")).toEqual(before);
  });
});

describe("markFailed", () => {
  // So Try again never sends it twice (see retry.ts).
  it("says something went out once the move itself was sent, whatever stopped it", async () => {
    const sent = await insertAction({ phase: "sending", txs: [{ chain: "monad", hash: "0xdef" }] });
    const setUp = await insertAction({
      phase: "sending",
      txs: [{ chain: "monad", hash: "0xabc", setup: true }],
    });
    expect(await markFailed(sent.id, "Not filled.", "unknown")).toMatchObject({
      status: "failed",
      failureKind: "sent",
    });
    expect(await markFailed(setUp.id, "Quote moved.", "price")).toMatchObject({
      status: "failed",
      failureKind: "price",
    });
  });

  // Its card then says no one filled it, not that money may have gone.
  it("keeps an order its recipe knows nobody filled unfilled, though it was sent", async () => {
    const unfilled = await insertAction({
      phase: "sending",
      txs: [{ chain: "monad", hash: "0xdef" }],
    });
    expect(await markFailed(unfilled.id, "No one filled it.", "unfilled")).toMatchObject({
      status: "failed",
      failureKind: "unfilled",
    });
  });

  it("forgets why it stopped once it finishes after all", async () => {
    const { id } = await insertAction({
      phase: "sending",
      txs: [{ chain: "base", walletTxId: "p1" }],
    });
    await markStopped(id, "socket hang up", "glitch");
    expect(await finish(id)).toMatchObject({ status: "done", failureKind: null });
  });
});

describe("keepTxsSafely", () => {
  it("keeps each transaction once however often it is reported, by hash or else by the wallet's id", async () => {
    const { id } = await insertAction();
    const approval = { chain: "base", hash: "0xa", setup: true as const };
    const accepted = { chain: "base", walletTxId: "p1" };
    const landed = { chain: "base", walletTxId: "p1", hash: "0xb" };
    await keepTxsSafely(id, [approval, accepted]);
    await keepTxsSafely(id, [approval, accepted]);
    await keepTxsSafely(id, [accepted, landed]);
    await keepTxsSafely(id, [landed]);
    expect((await actionRow(id))?.txs).toEqual([approval, accepted, landed]);
  });

  it("keeps a relayed send once by its relayer id until its hash comes back", async () => {
    const { id } = await insertAction();
    const taken = { chain: "polygon", relayerId: "r1", setup: true as const };
    const landed = { ...taken, hash: "0xb" };
    await keepTxsSafely(id, [taken]);
    await keepTxsSafely(id, [taken, landed]);
    await keepTxsSafely(id, [landed]);
    expect((await actionRow(id))?.txs).toEqual([taken, landed]);
  });
});

describe("recordResult", () => {
  it("writes a chat's sale to the specialist whose holding it sold, past what Other held", async () => {
    const ai = await insertSpecialist();
    const bought = await insertAction({ specialistId: ai.id, status: "done" });
    await settledLongAgo(bought.id);
    await db.insert(fills).values({
      actionId: bought.id,
      specialistId: ai.id,
      chain: "solana",
      instrument: "nvda",
      side: "buy",
      quantity: "10",
      usdValue: "100",
    });
    const sell = (heldBefore: bigint | null) =>
      insertAction({
        tool: "stock_trade",
        input: { side: "sell" },
        details: { [APPROVED_SALE_OF]: "solana:nvda" },
      }).then(async (action) => {
        await recordResult(
          action,
          {
            txs: [],
            fills: [
              { chain: "solana", instrument: "nvda", side: "sell", quantity: "4", usdValue: "40" },
            ],
          },
          heldBefore === null ? null : { units: heldBefore, readAt: Date.now() },
        );
        await settledLongAgo(action.id);
        return db
          .select({ specialistId: fills.specialistId, quantity: fills.quantity })
          .from(fills)
          .where(eq(fills.actionId, action.id));
      });

    // 11 there: 10 AI's by its books, 1 loose, so 1 of the 4 was Other's and 3 were AI's.
    expect(await sell(parseUnits("11", QUANTITY_DECIMALS))).toEqual(
      expect.arrayContaining([
        { specialistId: null, quantity: "1.000000000000000000" },
        { specialistId: ai.id, quantity: "3.000000000000000000" },
      ]),
    );
    // Unread, it's written where it was made, as before.
    expect(await sell(null)).toEqual([{ specialistId: null, quantity: "4.000000000000000000" }]);

    // 7 there, all AI's by its books, so this sale would be AI's, but with a Solana
    // transaction running that could move anything there, the read can't be trusted:
    // written where it was made.
    const other = await insertAction({
      status: "running",
      tool: "send_solana_transaction",
    });
    expect(await sell(parseUnits("7", QUANTITY_DECIMALS))).toEqual([
      { specialistId: null, quantity: "4.000000000000000000" },
    ]);
    await settledLongAgo(other.id);

    // Swapped for another token, what came in is theirs in the same shares, so AI's books
    // hold the Tesla its NVIDIA became rather than read as cash it got back.
    const swap = await insertAction({
      tool: "evm_swap",
      input: { chain: "base", sellToken: "NVDA", buyToken: "TSLA", amount: "40" },
      details: { [APPROVED_SALE_OF]: "solana:nvda" },
    });
    await recordResult(
      swap,
      {
        txs: [],
        fills: [
          { chain: "solana", instrument: "nvda", side: "sell", quantity: "4", usdValue: "40" },
          { chain: "solana", instrument: "tsla", side: "buy", quantity: "8", usdValue: "40" },
        ],
      },
      // 8 there, AI's books now 7, so 1 of them is loose.
      { units: parseUnits("8", QUANTITY_DECIMALS), readAt: Date.now() },
    );
    const swapped = await db
      .select({
        specialistId: fills.specialistId,
        instrument: fills.instrument,
        quantity: fills.quantity,
      })
      .from(fills)
      .where(eq(fills.actionId, swap.id));
    expect(swapped).toEqual(
      expect.arrayContaining([
        { specialistId: null, instrument: "nvda", quantity: "1.000000000000000000" },
        { specialistId: ai.id, instrument: "nvda", quantity: "3.000000000000000000" },
        { specialistId: null, instrument: "tsla", quantity: "2.000000000000000000" },
        { specialistId: ai.id, instrument: "tsla", quantity: "6.000000000000000000" },
      ]),
    );
  });

  it("writes what a card converts to pay for its picks to no specialist, though it holds the same token", async () => {
    const ai = await insertSpecialist();
    const bought = await insertAction({ specialistId: ai.id, status: "done" });
    await db.insert(fills).values({
      actionId: bought.id,
      specialistId: ai.id,
      chain: "base",
      instrument: "native",
      side: "buy",
      quantity: "1",
      usdValue: "3000",
    });
    // On AI's card, converting ETH that came in loose: AI's own ETH stays AI's.
    const convert = await insertAction({
      specialistId: ai.id,
      tool: "convert_to_cash",
      input: { chain: "base", token: "native", amount: "0.1" },
      details: { [APPROVED_SALE_OF]: "base:native" },
    });
    await recordResult(convert, {
      txs: [],
      fills: [
        { chain: "base", instrument: "native", side: "sell", quantity: "0.1", usdValue: "300" },
      ],
    });
    expect(
      await db
        .select({ specialistId: fills.specialistId, quantity: fills.quantity })
        .from(fills)
        .where(eq(fills.actionId, convert.id)),
    ).toEqual([{ specialistId: null, quantity: "0.100000000000000000" }]);
  });

  it("writes a result's fills and transactions once, however often it is retried", async () => {
    const action = await insertAction();
    const result = {
      txs: [{ chain: "base", hash: "0xa" }],
      fills: [
        { chain: "base", instrument: "nvda", side: "buy", quantity: "1", usdValue: "10" },
      ] as const,
    };
    await recordResult(action, result);
    await recordResult(action, result);
    expect((await actionRow(action.id))?.txs).toEqual(result.txs);
    expect(await db.select().from(fills).where(eq(fills.actionId, action.id))).toHaveLength(1);
  });

  it("keeps what a sale into cash brought back, so its card and the agent say it", async () => {
    const action = await insertAction({
      tool: "polymarket_order",
      input: { side: "sell" },
      details: { returnsUsd: "7.00" },
    });
    await recordResult(action, {
      txs: [],
      fills: [
        { chain: "polygon", instrument: "yes", side: "sell", quantity: "10", usdValue: "6.894321" },
      ],
    });
    expect(await actionRow(action.id)).toMatchObject({
      details: { returnsUsd: "7.00" },
      run: { returnedUsd: "6.89" },
    });
  });

  // A real Polymarket buy and sale told the agent nothing of the shares or the price they filled at.
  it("keeps what a move filled, in its app's words, and tells the agent once it is done", async () => {
    const action = await insertAction({ tool: "polymarket_order", input: { side: "buy" } });
    const filled = "Bought 1.6919 Yes shares at 88.9¢ each, $1.51 with Polymarket's fee";
    await recordResult(action, {
      txs: [],
      fills: [
        { chain: "polygon", instrument: "yes", side: "buy", quantity: "1.6919", usdValue: "1.51" },
      ],
      run: { filled },
    });
    const [done] = await db
      .update(actions)
      .set({ status: "done", phase: null })
      .where(eq(actions.id, action.id))
      .returning();
    expect(done?.run).toEqual({ filled, spentUsd: "1.51" });
    expect((await settledOutcome(done!))?.reason).toContain(
      `finished as done. ${filled}. It spent $1.51`,
    );
  });

  // A real Polymarket buy's card said $1.58, the most it could cost with Polymarket's fee at its
  // ceiling, and its receipt and Activity said so after it filled for $1.51.
  it("keeps what a buy really spent, so its receipt says that rather than its ceiling", async () => {
    const action = await insertAction({
      tool: "polymarket_order",
      input: { side: "buy" },
      amountUsd: "1.58",
    });
    await recordResult(action, {
      txs: [],
      fills: [
        {
          chain: "polygon",
          instrument: "yes",
          side: "buy",
          quantity: "1.6919",
          usdValue: "1.5084",
        },
      ],
    });
    const done = await actionRow(action.id);
    expect(done?.run).toEqual({ spentUsd: "1.51" });
    expect(moneyOf(done!)).toEqual({ flow: "in", usd: "1.51" });
  });

  it("keeps nothing spent for a perp, whose fills are its size, not the margin it put in", async () => {
    const action = await insertAction({
      tool: "hyperliquid_order",
      input: { market: "BTC", side: "long", usd: 10.4, leverage: 3 },
      amountUsd: "3.47",
    });
    await recordResult(action, {
      txs: [],
      fills: [
        {
          chain: "hyperliquid",
          instrument: "BTC",
          side: "buy",
          quantity: "0.0001",
          usdValue: "10.40",
        },
      ],
    });
    expect((await actionRow(action.id))?.run).toEqual({});
  });

  // A real $1 NVIDIA sale paid out $0.98863, all its card quoted, yet its card went from
  // "$0.99 coming back" to "$0.98" when it filled.
  it("rounds what a sale brought back to the nearest cent, as its card rounded the quote", async () => {
    const action = await insertAction({
      tool: "polymarket_order",
      input: { side: "sell" },
      details: { returnsUsd: "0.99" },
    });
    await recordResult(action, {
      txs: [],
      fills: [
        { chain: "polygon", instrument: "yes", side: "sell", quantity: "1", usdValue: "0.98863" },
      ],
    });
    expect((await actionRow(action.id))?.run).toEqual({ returnedUsd: "0.99" });
  });

  // A token sold home through Across readies cash rather than being a sell a specialist acts on,
  // but its card says what comes back all the same, so once done it says what came.
  it("keeps what a sale gathering cash brought back too", async () => {
    const action = await insertAction({
      tool: "bridge_usdc",
      input: {
        from_chain: "1",
        from_token: "0x07696DcaB55E62cfef953666b29Fe1970518cB00",
        to_chain: "monad",
        amount: "1",
      },
      details: { returnsUsd: "1.91" },
    });
    await recordResult(action, {
      txs: [],
      fills: [
        {
          chain: "eip155:1",
          instrument: "0x07696DcaB55E62cfef953666b29Fe1970518cB00",
          side: "sell",
          quantity: "1",
          usdValue: "1.894321",
        },
      ],
    });
    expect((await actionRow(action.id))?.run).toEqual({ returnedUsd: "1.89" });
  });
});
