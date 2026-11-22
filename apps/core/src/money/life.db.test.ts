import { eq, or } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, jobs } from "../db/schema.ts";
import { actionJob, reconcileJob } from "../jobs/action.ts";
import { insertAction, wipe } from "../test/db.ts";
import { evmClient } from "./chains.ts";
import { retryRefusal } from "./failure.ts";
import { begins, step, STEPS, type MoveState, type Step } from "./life.ts";

vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmClient: vi.fn(),
}));

beforeEach(() => wipe(actions, jobs));

const longAgo = new Date(Date.now() - 60 * 60_000);
const sent = [{ chain: "base", hash: "0xsent" }];

/** A row in each state a move can be in, as the code that leaves it there writes it. */
const IN: Record<MoveState, Parameters<typeof insertAction>[0]> = {
  awaiting_permission: { status: "awaiting_permission" },
  queued: { phase: "queued" },
  sending: { phase: "sending", startedAt: longAgo },
  landing: { phase: "landing", startedAt: longAgo, txs: sent, run: { lands: "$5.00 on Base" } },
  unsure: { phase: "unsure", startedAt: longAgo, txs: sent, error: "socket hang up" },
  needs_owner: { phase: "needs_owner", startedAt: longAgo, txs: sent, error: "Unrecorded." },
  done: { status: "done", startedAt: longAgo },
  failed: { status: "failed", startedAt: longAgo, error: "Not filled.", failureKind: "glitch" },
  cancelled: { status: "cancelled" },
  replaced: { status: "replaced" },
  retracted: { status: "retracted", error: "Taken back by Auni: it no longer fits." },
};
const STATES = Object.keys(IN) as MoveState[];

/** A move's state: how far it has got while it runs, else where its card stands. */
const stateOf = (row: { status: string; phase: string | null }) => row.phase ?? row.status;

const rowOf = async (id: string) => (await db.select().from(actions).where(eq(actions.id, id)))[0]!;

/** Every step a move may take, by the state it is in, and where it leaves it. Any other is refused. */
const MAY: Record<MoveState, Partial<Record<Step, MoveState>>> = {
  awaiting_permission: {
    allow: "queued",
    decline: "cancelled",
    replace: "replaced",
    retract: "retracted",
  },
  queued: { claim: "sending", skip: "failed", apply: "done" },
  sending: {
    finish: "done",
    fail: "failed",
    depart: "landing",
    stop: "unsure",
    hold: "needs_owner",
  },
  landing: { finish: "done" },
  unsure: { finish: "done", fail: "failed", hold: "needs_owner" },
  needs_owner: { finish: "done", fail: "failed" },
  done: {},
  failed: { retry: "queued" },
  cancelled: {},
  replaced: {},
  retracted: {},
};

describe("a move's life", () => {
  it.each(STATES)(
    "from %s takes only the steps that state allows, and is left as it was by any other",
    async (state) => {
      for (const name of Object.keys(STEPS) as Step[]) {
        const before = await insertAction(IN[state]);
        expect(stateOf(before)).toBe(state);
        const moved = await step(db, name, eq(actions.id, before.id));
        const after = await rowOf(before.id);
        const to = MAY[state][name];
        if (to) {
          expect(moved).toEqual([after]);
          expect(stateOf(after)).toBe(to);
        } else {
          expect(moved).toEqual([]);
          expect(after).toEqual(before);
        }
      }
    },
  );

  it("moves no move when it is told which by no condition at all", async () => {
    const move = await insertAction(IN.sending);
    expect(await step(db, "finish", or())).toEqual([]);
    expect(await rowOf(move.id)).toEqual(move);
  });

  it("starts a row waiting for the owner, queued, or done, and nowhere else", () => {
    expect(begins("awaiting_permission")).toEqual({ status: "awaiting_permission", phase: null });
    expect(begins("queued")).toEqual({ status: "running", phase: "queued" });
    expect(begins("done")).toEqual({ status: "done", phase: null });
  });

  it("claims a move once, clears a failed run for its next attempt, and forgets why a done one stopped", async () => {
    const queued = await insertAction(IN.queued);
    const [claimed] = await step(db, "claim", eq(actions.id, queued.id));
    expect(claimed?.startedAt).toBeInstanceOf(Date);
    expect(await step(db, "claim", eq(actions.id, queued.id))).toEqual([]);

    const failed = await insertAction({ ...IN.failed, run: { venue: "Kuru" } });
    const [retried] = await step(db, "retry", eq(actions.id, failed.id));
    expect(retried).toMatchObject({
      phase: "queued",
      startedAt: null,
      error: null,
      failureKind: null,
    });
    // The last run's notes go with it: toMatchObject would let `{}` match any object.
    expect(retried?.run).toEqual({});

    const unsure = await insertAction({ ...IN.unsure, failureKind: "glitch" });
    expect(await step(db, "finish", eq(actions.id, unsure.id))).toMatchObject([
      { status: "done", failureKind: null },
    ]);
  });
});

/** The action job's `cutShort`, as the runner calls it for a job whose run was cut off. */
const cutOff = (actionId: string) =>
  actionJob.cutShort!(
    { actionId, lane: actionId, holding: actionId },
    { id: "cut", createdAt: new Date(), attempts: 1, signal: AbortSignal.abort() },
    "crashed",
  );
const reconcile = () =>
  reconcileJob.run(
    {},
    { id: "reconcile", createdAt: new Date(), attempts: 1, signal: AbortSignal.abort() },
  );
const receipts = (status: "success" | "reverted") =>
  vi
    .mocked(evmClient)
    .mockReturnValue({ getTransactionReceipt: async () => ({ status }) } as never);
const landingJobs = async () =>
  (await db.select().from(jobs).where(eq(jobs.kind, "landing"))).length;

describe("a move whose run was cut off", () => {
  it("runs again when it was still queued: nothing was tried", async () => {
    const move = await insertAction(IN.queued);
    expect(await cutOff(move.id)).toBe("rerun");
    expect(await rowOf(move.id)).toEqual(move);
  });

  it("fails, never to run again on a tap, when it was sending and kept no send", async () => {
    const move = await insertAction(IN.sending);
    expect(await cutOff(move.id)).toBeUndefined();
    const after = await rowOf(move.id);
    expect(after).toMatchObject({ status: "failed", failureKind: "sent" });
    expect(retryRefusal(after)).toBe("not_retryable");
  });

  it("settles from its receipts at once when it was sending and kept a send that landed", async () => {
    const move = await insertAction({ ...IN.sending, tool: "withdraw_usdc", txs: sent });
    receipts("success");
    expect(await cutOff(move.id)).toBeUndefined();
    expect(await rowOf(move.id)).toMatchObject({ status: "done", phase: null });
  });

  it("is unsure when its receipts can't be read yet, and reconcile settles it from them", async () => {
    const move = await insertAction({ ...IN.sending, tool: "withdraw_usdc", txs: sent });
    vi.mocked(evmClient).mockReturnValue({
      getTransactionReceipt: async () => {
        throw new Error("HTTP request failed. Status: 500");
      },
    } as never);
    expect(await cutOff(move.id)).toBeUndefined();
    expect(await rowOf(move.id)).toMatchObject({ phase: "unsure", failureKind: "sent" });
    receipts("success");
    await reconcile();
    expect(await rowOf(move.id)).toMatchObject({ status: "done", phase: null, failureKind: null });

    const reverted = await insertAction({ ...IN.unsure, tool: "withdraw_usdc" });
    receipts("reverted");
    await reconcile();
    expect(await rowOf(reverted.id)).toMatchObject({ status: "failed", failureKind: "sent" });
  });

  // Every way into being held, and every way out, is money/held.db.test.ts.
  it("is held for the owner once its money moved and nothing reads back what it traded", async () => {
    const order = await insertAction({
      ...IN.unsure,
      tool: "polymarket_order",
      input: { side: "buy" },
    });
    receipts("success");
    await reconcile();
    const held = await rowOf(order.id);
    expect(held).toMatchObject({ status: "running", phase: "needs_owner" });
    // Reconcile reads it again, and while nothing answers it is left exactly as it was held.
    await reconcile();
    expect(await rowOf(order.id)).toEqual(held);
  });

  it("goes on landing, watched again, when it had already sent", async () => {
    const move = await insertAction(IN.landing);
    expect(await cutOff(move.id)).toBeUndefined();
    expect(await rowOf(move.id)).toEqual(move);
    expect(await landingJobs()).toBe(1);
  });

  // An unsure one has its receipts read once, as a run stopped by a throw has (above).
  it("is left exactly as it was in every other state", async () => {
    const read = ["queued", "sending", "landing", "unsure"];
    for (const state of STATES.filter((each) => !read.includes(each))) {
      const move = await insertAction(IN[state]);
      expect(await cutOff(move.id)).toBeUndefined();
      expect(await rowOf(move.id)).toEqual(move);
    }
    expect(await landingJobs()).toBe(0);
  });
});
