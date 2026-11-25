import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";
import { actions, jobs, threads } from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { allowAction, allowProposal, declineAction, declineProposal } from "./decide.ts";

beforeEach(() => wipe(threads, actions, jobs));

const statusOf = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0]!.status;

// Found in review: a card recorded before cards said every permission a move leaves, still
// waiting as Auni updated, could be allowed as the owner saw it, without them. Every surface
// decides here, so none can.
describe("a card drawn before cards said all they say now", () => {
  const PLAN = "00000000-0000-4000-8000-0000000000a2";

  it("allows nothing on a lone move's tap, which a card drawn now allows", async () => {
    const old = await insertAction({ status: "awaiting_permission", cardFormat: 1 });
    expect(await allowAction(old.id, true)).toEqual({ kind: "out_of_date" });
    expect(await statusOf(old.id)).toBe("awaiting_permission");
    const now = await insertAction({ status: "awaiting_permission" });
    expect((await allowAction(now.id, true)).kind).toBe("allowed");
  });

  it("allows no leg of a plan with one such leg", async () => {
    const legs = await Promise.all([
      insertAction({ status: "awaiting_permission", proposalId: PLAN }),
      insertAction({ status: "awaiting_permission", proposalId: PLAN, cardFormat: 1 }),
    ]);
    expect(await allowProposal(PLAN)).toBe("out_of_date");
    expect(await Promise.all(legs.map(({ id }) => statusOf(id)))).toEqual([
      "awaiting_permission",
      "awaiting_permission",
    ]);
  });

  // Found in review: the tap took such a card back first, so the agent heard it could put the
  // move up again, not that the owner had said no. The web app and every channel decline here.
  it("is declined on a lone move's Decline, and the thread hears the owner's no", async () => {
    const thread = await insertThread();
    const old = await insertAction({
      threadId: thread.id,
      status: "awaiting_permission",
      cardFormat: 1,
    });
    expect((await declineAction(old.id))?.id).toBe(old.id);
    expect(await statusOf(old.id)).toBe("cancelled");
    expect((await queued("turn")).map(({ data }) => data.reason)).toEqual([
      expect.stringContaining(`The owner declined action ${old.id}`),
    ]);
  });

  it("is declined, every leg, on a plan's Decline, and the thread hears the owner's no", async () => {
    const thread = await insertThread();
    const legs = await Promise.all([
      insertAction({ threadId: thread.id, status: "awaiting_permission", proposalId: PLAN }),
      insertAction({
        threadId: thread.id,
        status: "awaiting_permission",
        proposalId: PLAN,
        cardFormat: 1,
      }),
    ]);
    expect(await declineProposal(PLAN)).toHaveLength(2);
    expect(await Promise.all(legs.map(({ id }) => statusOf(id)))).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect((await queued("turn")).map(({ data }) => data.reason)).toEqual([
      expect.stringContaining(`The owner declined proposal ${PLAN}`),
    ]);
  });

  it("leaves an ask, whose card no format changed, and a card already decided", async () => {
    const target = await insertThread();
    const ask = await insertAction({
      threadId: target.id,
      input: { thread_id: target.id, act_mode: "within_limits", budget_usd: "100.00" },
      status: "awaiting_permission",
      tool: "set_thread_autonomy",
      venue: null,
      amountUsd: "0",
      cardFormat: 1,
    });
    expect((await allowAction(ask.id)).kind).toBe("allowed");
    const done = await insertAction({ status: "done", cardFormat: 1 });
    expect(await allowAction(done.id)).toEqual({ kind: "not_waiting" });
  });
});
