import { CLOSED, HELD, type HeldWhy } from "@auni/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drawCard } from "../channels/draw.ts";
import { readThreadWire } from "../conversation/threads.ts";
import { db } from "../db/client.ts";
import { actions, fills, jobs, threads } from "../db/schema.ts";
import { actionJob, reconcileJob } from "../jobs/action.ts";
import { wakeThread } from "../jobs/kinds.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { actionWire, executeAction, settleStopped } from "./actions.ts";
import { APPROVED_SALE, APPROVED_SALE_OF } from "./approved.ts";
import { evmClient } from "./chains.ts";
import { retryRefusal } from "./failure.ts";
import { evmTokenKey, fillIdentity } from "./fill-key.ts";
import { checkHeld, closeHeld } from "./held.ts";
import { walletFlows } from "./made.ts";
import { threadPot } from "./pot.ts";
import { MayHaveSent, type Fill, type KeptTx, type ReadBack } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";
import { recordResult } from "./record.ts";
import { recordStatement } from "./statements.ts";

// A held move, from every way in to every way out, with the chain, the wallet and the venue's
// statement stood in. Each recipe's own read back is tested beside the recipe; here one is
// stood in for, so the life around it is what is tested.

vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmClient: vi.fn(),
}));
vi.mock("./wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  walletAddresses: async () => ({ evm: OWNER, solana: null }),
  signerFor: async () => ({ evmAddress: OWNER }),
}));
// Wrapped, so a test can see which write a wake was queued in.
vi.mock("../jobs/kinds.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jobs/kinds.ts")>();
  return { ...actual, wakeThread: vi.fn(actual.wakeThread) };
});
vi.mock("./statements.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordStatement: vi.fn(),
}));

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const NVDA = "0x1111111111111111111111111111111111111111";
const longAgo = new Date(Date.now() - 60 * 60_000);
const hashed: KeptTx[] = [{ chain: "monad", hash: "0xsent" }];
/** A send that got no answer: kept with nothing to read (see MayHaveSent). */
const unanswered: KeptTx[] = [{ chain: "polygon" }];
const bought: Fill = {
  ...evmTokenKey("monad", NVDA),
  side: "buy",
  quantity: "0.25",
  usdValue: "50.00",
};

/** A buy of a token with USDC, whose recipe reads back what it traded. */
const swap = { tool: "evm_swap", input: { chain: "monad", sellToken: "USDC", buyToken: NVDA } };
/** A trade whose recipe has no read back, and whose venue keeps no statement. */
const order = { tool: "polymarket_order", venue: "polymarket", input: { side: "buy" } };
/** An order on a venue whose statement Auni reads, which records its fills. */
const perp = { tool: "hyperliquid_order", venue: "hyperliquid", input: {} };

const readBack = vi.spyOn(recipeForTool("evm_swap")!, "readBack");
const chainSays = (status: "success" | "reverted" | "unknown" | "down") =>
  vi.mocked(evmClient).mockReturnValue({
    getTransactionReceipt: async () => {
      if (status === "down") throw new Error("HTTP request failed. Status: 500");
      if (status === "unknown") {
        const { TransactionReceiptNotFoundError } = await import("viem");
        throw new TransactionReceiptNotFoundError({ hash: "0xsent" });
      }
      return { status };
    },
  } as never);

const rowOf = async (id: string) => (await db.select().from(actions).where(eq(actions.id, id)))[0]!;
const fillsOf = (id: string) =>
  db
    .select({ side: fills.side, quantity: fills.quantity, threadId: fills.threadId })
    .from(fills)
    .where(eq(fills.actionId, id));
const jobsOf = async (kind: string) =>
  (await db.select().from(jobs).where(eq(jobs.kind, kind))) as {
    key: string | null;
    data: { reason?: string };
  }[];
const context = { id: "job", createdAt: new Date(), attempts: 1, signal: AbortSignal.abort() };
const reconcile = () => reconcileJob.run({}, context);
/** The action job's `cutShort`, as the runner calls it for a job whose run was cut off. */
const cutOff = (actionId: string) =>
  actionJob.cutShort!({ actionId, lane: actionId, holding: actionId }, context, "crashed");
type Fields = NonNullable<Parameters<typeof insertAction>[0]>;
/** A stopped move as its run left it: unsure, with what it kept of its sends. */
const stopped = (fields: Fields) =>
  insertAction({ phase: "unsure", startedAt: longAgo, error: "socket hang up", ...fields });

beforeEach(async () => {
  await wipe(actions, jobs);
  readBack.mockReset();
  vi.mocked(recordStatement).mockReset();
  vi.mocked(wakeThread).mockClear();
});

/** What a stopped move comes to, by what it is, what it kept, and what the world then says. */
interface PathIn {
  readonly name: string;
  readonly move: Fields;
  readonly chain: Parameters<typeof chainSays>[0];
  /** What its recipe reads back, where it has a reader. */
  readonly reads?: ReadBack | null | Error;
  /** What the first read, moments after the stop, leaves it as. */
  readonly atOnce: "done" | "failed" | "unsure" | HeldWhy;
  /** What reconcile's later read leaves it as. */
  readonly later: "done" | "failed" | "unsure" | HeldWhy;
}

const PATHS: readonly PathIn[] = [
  {
    name: "a withdrawal whose send confirmed: no trade, so nothing to read back",
    move: { tool: "withdraw_usdc", txs: hashed },
    chain: "success",
    atOnce: "done",
    later: "done",
  },
  {
    name: "a swap whose send confirmed, read back from its receipts",
    move: { ...swap, txs: hashed },
    chain: "success",
    reads: { fills: [bought] },
    atOnce: "done",
    later: "done",
  },
  {
    name: "a swap whose send reverted: nothing moved, and nothing is read back",
    move: { ...swap, txs: hashed },
    chain: "reverted",
    atOnce: "failed",
    later: "failed",
  },
  {
    name: "a swap whose receipts say all it sold came back",
    move: { ...swap, txs: hashed },
    chain: "success",
    reads: "nothing moved",
    atOnce: "failed",
    later: "failed",
  },
  {
    name: "a swap whose receipts can't say yet what it got (a maker pays later)",
    move: { ...swap, txs: hashed },
    chain: "success",
    reads: null,
    atOnce: "unsure",
    later: "unrecorded",
  },
  {
    name: "a swap whose read back fails",
    move: { ...swap, txs: hashed },
    chain: "success",
    reads: new Error("HTTP request failed. Status: 500"),
    atOnce: "unsure",
    later: "unrecorded",
  },
  {
    name: "a swap whose receipt can't be read at all",
    move: { ...swap, txs: hashed },
    chain: "down",
    atOnce: "unsure",
    later: "unsure",
  },
  {
    name: "a swap the chain has not confirmed yet",
    move: { ...swap, txs: hashed },
    chain: "unknown",
    atOnce: "unsure",
    later: "unsure",
  },
  {
    name: "a swap still unconfirmed a day after it was sent",
    move: { ...swap, txs: hashed, startedAt: new Date(Date.now() - 25 * 60 * 60_000) },
    chain: "unknown",
    atOnce: "overdue",
    later: "overdue",
  },
  {
    name: "a venue order that traded, on a venue with no reader and no statement",
    move: { ...order, txs: [{ chain: "polygon", hash: "0xsent" }] },
    chain: "success",
    atOnce: "unrecorded",
    later: "unrecorded",
  },
  {
    name: "a venue order that never got an answer, with nothing to read",
    move: { ...order, txs: unanswered },
    chain: "success",
    atOnce: "unanswered",
    later: "unanswered",
  },
  {
    // A first Kuru trade opens the account in a set-up send; a wallet that never heard back of
    // the trade keeps it with nothing to read. Its receipts are only the set-up's, so a reader of
    // receipts would call it "nothing moved" though the trade may have landed.
    name: "a swap whose set-up confirmed and whose trade never got an answer",
    move: { ...swap, txs: [{ chain: "monad", hash: "0xopened", setup: true }, { chain: "monad" }] },
    chain: "success",
    reads: "nothing moved",
    atOnce: "unanswered",
    later: "unanswered",
  },
  {
    name: "an unanswered order on a venue whose statement doesn't show it",
    move: { ...perp, txs: [{ chain: "hyperliquid" }] },
    chain: "success",
    atOnce: "unsure",
    later: "unanswered",
  },
];

/** A move's state as the table says it: where it settled, unsure, or why it is held. */
const stateOf = (row: Awaited<ReturnType<typeof rowOf>>) =>
  row.phase === "needs_owner" ? row.run.held : (row.phase ?? row.status);

describe("every way into being held, and what settles without it", () => {
  it.each(PATHS)("$name", async ({ move, chain, reads, atOnce, later }) => {
    chainSays(chain);
    if (reads instanceof Error) readBack.mockRejectedValue(reads);
    else if (reads !== undefined) readBack.mockResolvedValue(reads);
    const thread = await insertThread();
    const first = await stopped({ ...move, threadId: thread.id });
    await settleStopped(first);
    expect(stateOf(await rowOf(first.id)), "the first read").toBe(atOnce);

    const second = await stopped({ ...move, threadId: thread.id });
    await reconcile();
    const row = await rowOf(second.id);
    expect(stateOf(row), "reconcile's read").toBe(later);
    // A recipe's reader reads receipts, so it is never asked about a send that has none.
    if (move.txs?.some((tx) => !tx.hash)) expect(readBack).not.toHaveBeenCalled();
    if (row.phase !== "needs_owner") return;
    // Held, it says why in the words every surface reads, and keeps what it sent.
    expect(row).toMatchObject({ status: "running", error: HELD[row.run.held!], txs: move.txs });
  });

  it("records a trade it read back as its run would have, and says how it was learned", async () => {
    chainSays("success");
    readBack.mockResolvedValue({ fills: [bought] });
    const thread = await insertThread();
    const move = await stopped({ ...swap, txs: hashed, threadId: thread.id });
    await reconcile();
    expect(await rowOf(move.id)).toMatchObject({
      status: "done",
      error: null,
      run: { settledBy: "read back" },
    });
    expect(await fillsOf(move.id)).toEqual([
      { side: "buy", quantity: "0.250000000000000000", threadId: thread.id },
    ]);
  });

  it("finishes an unanswered order once its venue's statement shows what it traded", async () => {
    const move = await stopped({ ...perp, txs: [{ chain: "hyperliquid" }] });
    // The statement names the order as this move's and records its fills itself.
    vi.mocked(recordStatement).mockImplementation(async () => {
      await db.insert(fills).values({ ...bought, actionId: move.id });
    });
    expect(await settleStopped(move)).toMatchObject({ status: "done" });
  });
});

/** A held move in its thread, as reconcile leaves one. */
async function heldMove(
  why: HeldWhy,
  fields: Fields = {},
): Promise<Awaited<ReturnType<typeof rowOf>>> {
  const thread = await insertThread();
  const move = await stopped({
    ...(why === "unanswered" ? { ...order, txs: unanswered } : { ...swap, txs: hashed }),
    threadId: thread.id,
    ...fields,
  });
  chainSays("success");
  readBack.mockResolvedValue(null);
  await reconcile();
  const held = await rowOf(move.id);
  expect(held).toMatchObject({ phase: "needs_owner", run: { held: why } });
  return held;
}

describe("a held move", () => {
  it("is told to its thread once, however often it is read again", async () => {
    const held = await heldMove("unrecorded");
    // In the write that holds it, so a hold that didn't commit tells no one, and one that did
    // always does.
    const [[, , told]] = vi.mocked(wakeThread).mock.calls as [[string, string, { tx?: unknown }]];
    expect(told.tx).toBeDefined();
    expect(told.tx).not.toBe(db);
    await reconcile();
    await checkHeld(held.id);
    const turns = await jobsOf("turn");
    expect(turns.map(({ key }) => key)).toEqual([`action-held-${held.id}-a1`]);
    const [{ data }] = turns as [(typeof turns)[number]];
    expect(data.reason).toContain(`Action ${held.id} (Buy about $10 of Nvidia stock) is held.`);
    expect(data.reason).toContain(HELD.unrecorded);
    expect(data.reason).toContain("0xsent on monad");
    expect(data.reason).toContain("Its run stopped with: socket hang up");
    // The row itself is as it was held: reading it again changed nothing.
    expect(await rowOf(held.id)).toEqual(held);
  });

  it("settles by itself once the world answers, and its thread hears how it ended", async () => {
    const held = await heldMove("unrecorded");
    readBack.mockResolvedValue({ fills: [bought] });
    await reconcile();
    expect(await rowOf(held.id)).toMatchObject({ status: "done", phase: null, error: null });
    expect((await jobsOf("turn")).map(({ key }) => key)).toEqual([
      `action-held-${held.id}-a1`,
      `action-settled-${held.id}-a1`,
    ]);
  });

  it("is read again now on the owner's Check again, which settles it or leaves it held", async () => {
    const held = await heldMove("unrecorded");
    expect(await checkHeld(held.id)).toEqual(held);
    readBack.mockResolvedValue({ fills: [bought] });
    expect(await checkHeld(held.id)).toMatchObject({ status: "done" });
    expect(await fillsOf(held.id)).toHaveLength(1);
    // No longer held, so a tap from a screen behind finds nothing to do.
    expect(await checkHeld(held.id)).toBeNull();
    expect(await closeHeld(held.id)).toBeNull();
  });

  it("records a trade once when two reads write it at the same moment", async () => {
    const held = await heldMove("unrecorded");
    // One read is part way through writing what it read: it has the move's row and its fill,
    // not yet committed. A second read that writes now must wait for it, then add nothing.
    let finishFirst!: () => void;
    let firstHasRow!: () => void;
    const rowTaken = new Promise<void>((resolve) => (firstHasRow = resolve));
    const first = db.transaction(async (tx) => {
      await tx
        .select({ id: actions.id })
        .from(actions)
        .where(eq(actions.id, held.id))
        .for("update");
      await tx.insert(fills).values({ ...bought, actionId: held.id });
      firstHasRow();
      await new Promise<void>((resolve) => (finishFirst = resolve));
    });
    await rowTaken;
    const second = recordResult(held, { txs: [], fills: [bought] });
    let secondDone = false;
    void second.then(() => (secondDone = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(secondDone, "the second write waits on the first").toBe(false);
    finishFirst();
    await Promise.all([first, second]);
    expect(await fillsOf(held.id)).toHaveLength(1);
  });

  it("is read again by Check again only while it is held", async () => {
    // Stopped, and not yet held: reconcile's to read, not a tap's.
    const unsure = await stopped({ ...swap, txs: hashed, threadId: (await insertThread()).id });
    chainSays("success");
    readBack.mockResolvedValue({ fills: [bought] });
    expect(await checkHeld(unsure.id)).toBeNull();
    expect(await rowOf(unsure.id)).toEqual(unsure);
    expect(await fillsOf(unsure.id)).toEqual([]);
  });

  it("settles without its held words once its venue's statement recorded what it traded", async () => {
    const thread = await insertThread();
    const order = await stopped({ ...perp, txs: [{ chain: "hyperliquid" }], threadId: thread.id });
    await reconcile();
    expect((await rowOf(order.id)).run.held).toBe("unanswered");
    // The statement job, reading Hyperliquid on its own, names the order as this move's.
    await db.insert(fills).values({ ...bought, actionId: order.id });
    await reconcile();
    expect(await rowOf(order.id)).toMatchObject({ status: "done", error: null });
  });

  it("closes as done when its money moved, with no fill invented", async () => {
    const held = await heldMove("unrecorded");
    const closed = await closeHeld(held.id);
    expect(closed).toMatchObject({
      status: "done",
      phase: null,
      error: CLOSED.moved,
      run: { held: "unrecorded", settledBy: "owner" },
    });
    expect(await fillsOf(held.id)).toEqual([]);
    expect((await jobsOf("turn")).map(({ key }) => key)).toContain(`action-settled-${held.id}-a1`);
  });

  it("closes as failed, never to run again, when nothing shows it went through", async () => {
    const held = await heldMove("unanswered");
    const closed = await closeHeld(held.id);
    expect(closed).toMatchObject({
      status: "failed",
      failureKind: "sent",
      error: CLOSED.unknown,
      run: { settledBy: "owner" },
    });
    expect(retryRefusal(closed!)).toBe("not_retryable");
    expect(await fillsOf(held.id)).toEqual([]);
  });

  it("records what a last read finds rather than closing over it", async () => {
    const held = await heldMove("unrecorded");
    readBack.mockResolvedValue({ fills: [bought] });
    expect(await closeHeld(held.id)).toMatchObject({ status: "done", error: null });
    expect(await fillsOf(held.id)).toHaveLength(1);
  });

  it("is never sent again: no tap on it queues a run", async () => {
    const held = await heldMove("unanswered");
    await checkHeld(held.id);
    await closeHeld(held.id);
    expect(await jobsOf("action")).toEqual([]);
  });
});

describe("a thread's budget while one of its moves is held", () => {
  const potOf = async (id: string) =>
    db.transaction(async (tx) => {
      const [thread] = await tx.select().from(threads).where(eq(threads.id, id));
      return threadPot(tx, thread!);
    });
  const nvda = fillIdentity(evmTokenKey("monad", NVDA));

  it("counts a held buy as spent, and a close of one that went through keeps it spent", async () => {
    const thread = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const held = await heldMove("unrecorded", { threadId: thread.id, amountUsd: "40" });
    expect((await potOf(thread.id)).freeCashCents).toBe(6_000n);
    await closeHeld(held.id);
    // What it bought is the owner's outside the thread's budget now, so its budget is lower by that.
    const [after] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(after?.budgetUsd).toBe("60.00");
    expect((await potOf(thread.id)).freeCashCents).toBe(6_000n);
  });

  it("keeps a held buy spent when it is closed with nothing showing whether it went", async () => {
    const thread = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const held = await heldMove("unanswered", { threadId: thread.id, amountUsd: "40" });
    expect((await potOf(thread.id)).freeCashCents).toBe(6_000n);
    await closeHeld(held.id);
    // If the order did fill, its $40 is gone; the thread never spends it a second time.
    expect((await potOf(thread.id)).freeCashCents).toBe(6_000n);
  });

  it("takes a closed sale's holding out of what the thread may sell, and frees nothing", async () => {
    const thread = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const earlier = await insertAction({ status: "done", threadId: thread.id });
    await db.insert(fills).values({
      ...bought,
      quantity: "2",
      usdValue: "80",
      actionId: earlier.id,
      threadId: thread.id,
    });
    const held = await heldMove("unrecorded", {
      tool: "evm_swap",
      input: { chain: "monad", sellToken: NVDA, buyToken: "USDC" },
      threadId: thread.id,
      amountUsd: "20",
      details: { [APPROVED_SALE]: "0.5", [APPROVED_SALE_OF]: nvda },
    });
    expect((await potOf(thread.id)).holds.get(nvda)).toBe(1_500_000_000_000_000_000n);
    await closeHeld(held.id);
    const after = await potOf(thread.id);
    expect(after.holds.get(nvda)).toBe(1_500_000_000_000_000_000n);
    // What the sale brought in is the owner's, outside the thread: free cash is as it was.
    expect(after.freeCashCents).toBe(2_000n);
    // Closed again by another tap, it leaves the books once.
    await closeHeld(held.id);
    expect((await potOf(thread.id)).holds.get(nvda)).toBe(1_500_000_000_000_000_000n);
  });

  it("moves a closed sale's holding to the owner's books, so what the wallet made is as it was", async () => {
    const thread = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const earlier = await insertAction({ status: "done", threadId: thread.id });
    await db.insert(fills).values({
      ...bought,
      quantity: "2",
      usdValue: "80",
      actionId: earlier.id,
      threadId: thread.id,
    });
    const held = await heldMove("unanswered", {
      tool: "evm_swap",
      input: { chain: "monad", sellToken: NVDA, buyToken: "USDC" },
      threadId: thread.id,
      amountUsd: "20",
      details: { [APPROVED_SALE]: "0.5", [APPROVED_SALE_OF]: nvda },
    });
    const putIn = async () => (await walletFlows()).reduce((sum, flow) => sum + flow.usd, 0);
    expect(await putIn()).toBe(80);
    await closeHeld(held.id);
    // Auni never read what the sale got, so closing it puts no money in or out of the wallet.
    expect(await putIn()).toBe(80);
    expect((await potOf(thread.id)).holds.get(nvda)).toBe(1_500_000_000_000_000_000n);
  });

  it("holds back only what a held sell may have sold, not everything it holds", async () => {
    const thread = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const earlier = await insertAction({ status: "done", threadId: thread.id });
    const other = evmTokenKey("monad", "0x2222222222222222222222222222222222222222");
    await db.insert(fills).values([
      { ...bought, quantity: "2", actionId: earlier.id, threadId: thread.id },
      { ...bought, ...other, quantity: "3", actionId: earlier.id, threadId: thread.id },
    ]);
    const sale = {
      tool: "evm_swap",
      input: { chain: "monad", sellToken: NVDA, buyToken: "USDC" },
      threadId: thread.id,
      details: { [APPROVED_SALE]: "0.5", [APPROVED_SALE_OF]: nvda },
    };
    // Still settling, a sell holds back every holding: what it sold isn't counted yet.
    const settling = await stopped({ ...sale, txs: hashed });
    expect((await potOf(thread.id)).holds.size).toBe(0);
    await db.delete(actions).where(eq(actions.id, settling.id));
    // Held, it takes only what its card approved selling out of what may be sold.
    await heldMove("unrecorded", sale);
    expect(Object.fromEntries((await potOf(thread.id)).holds)).toEqual({
      [nvda]: 1_500_000_000_000_000_000n,
      [fillIdentity(other)]: 3_000_000_000_000_000_000n,
    });
  });
});

describe("a run cut off after its order went out with no answer", () => {
  const execute = vi.spyOn(recipeForTool(order.tool)!, "execute");
  const sale = {
    ...order,
    input: { market: "fed-cuts-in-december", outcome: "Yes", side: "sell" },
    details: { returnsUsd: "24.80" },
  };
  afterEach(() => execute.mockReset());

  it("is held at once, and the owner sees it say so everywhere they would look", async () => {
    const thread = await insertThread();
    const move = await insertAction({
      ...sale,
      summary: "Sell 40 Yes shares of Fed cuts in December",
      threadId: thread.id,
    });
    // The venue has the order and its answer is on its way when the process dies: the runner,
    // starting again, finds the job cut short, and the run never hears back.
    execute.mockImplementation(({ posting }) =>
      posting("polygon", async () => {
        await cutOff(move.id);
        return new Promise<never>(() => {});
      }),
    );
    chainSays("success");
    void executeAction(move.id);
    await vi.waitFor(async () => expect((await rowOf(move.id)).phase).toBe("needs_owner"));

    // The card: no longer sending, with why, and never offering to run it again.
    const row = await rowOf(move.id);
    const wire = actionWire(row);
    expect(wire).toMatchObject({
      status: "running",
      phase: "needs_owner",
      error: HELD.unanswered,
      run: { held: "unanswered" },
      retryable: false,
    });
    // The thread's row in the sidebar: it needs the owner, and nothing is said to be moving.
    expect(await readThreadWire(thread.id)).toMatchObject({
      status: "needs_user",
      // Said with what it was to bring back, since the order's words don't say it.
      moneyLine: "Status unknown: Sell 40 Yes shares of Fed cuts in December, about $24.80 back",
      moving: null,
    });
    // A channel's copy gives the known outcome and a way to check it in the app.
    const link = "https://evo-t1.example.ts.net/app";
    const drawn = drawCard({ legs: [row], inTheApp: false, decidedIn: null, link }, null);
    expect(drawn.text).toContain(
      "Status unknown. Auni sent this and never heard back, so it won't send it again. Your Money page shows what you hold.",
    );
    expect(drawn.buttons).toEqual([[{ label: "Check status", url: link }]]);
    // The agent: woken once, told what is known and not to send it again.
    const [turn] = await jobsOf("turn");
    expect(turn?.data.reason).toContain("is held.");
    expect(turn?.data.reason).toContain("It kept no transaction hash.");
    expect(turn?.data.reason).toContain("Don't propose this move again while it is held");
  });

  it("is not kept as sent when the venue turns the order away", async () => {
    const move = await insertAction({ ...sale, threadId: (await insertThread()).id });
    execute.mockImplementation(({ posting }) =>
      posting("polygon", () => Promise.reject(new Error("Polymarket refused: not enough balance"))),
    );
    const failed = await executeAction(move.id);
    expect(failed).toMatchObject({ status: "failed", txs: [] });
    expect(failed.failureKind).not.toBe("sent");
  });

  it("keeps one mark when the venue never answers", async () => {
    const move = await insertAction({ ...sale, threadId: (await insertThread()).id });
    execute.mockImplementation(({ posting }) =>
      posting("polygon", () =>
        Promise.reject(new MayHaveSent({ chain: "polygon" }, "Polymarket", "timeout")),
      ),
    );
    chainSays("success");
    expect(await executeAction(move.id)).toMatchObject({ phase: "needs_owner", txs: unanswered });
  });
});
