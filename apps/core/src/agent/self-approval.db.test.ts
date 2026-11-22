import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, threads } from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { toolsFor } from "./mcp.ts";

// No tool the agent holds decides a card, of any kind, in any thread: every Allow and Decline
// goes through decideActions, which only the owner's own routes and channel presses reach.

const decided = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../money/actions.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decideActions: async () => {
    decided.calls += 1;
    throw new Error("a tool tried to decide a card");
  },
}));

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in this test");
  });
  for (const level of ["error", "warn"] as const)
    vi.spyOn(console, level).mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());
beforeEach(async () => {
  decided.calls = 0;
  await wipe(threads, actions);
});

describe("the agent's tools", () => {
  it("never decide a card, in any thread", async () => {
    const places = [await insertThread(), await insertThread({ actMode: "ask_first" })];
    const target = places[1]!;
    const asks = await Promise.all(
      ["stock_trade", "set_thread_autonomy"].map((tool) =>
        insertAction({
          tool,
          threadId: target.id,
          status: "awaiting_permission",
          input: { thread_id: target.id, act_mode: "within_limits", budget_usd: "100.00" },
        }),
      ),
    );
    for (const thread of places) {
      for (const { id } of asks) {
        const input = {
          actionId: id,
          action_id: id,
          id,
          proposalId: id,
          thread_id: target.id,
          approve: true,
          decision: "allow",
        };
        for (const tool of toolsFor({ thread })) {
          await Promise.race([
            Promise.resolve()
              .then(() => tool.handler(input as never))
              .catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
        }
      }
    }
    expect(decided.calls).toBe(0);
    for (const { id } of asks) {
      const [row] = await db.select().from(actions).where(eq(actions.id, id));
      expect(row?.status).toBe("awaiting_permission");
    }
    const [row] = await db.select().from(threads).where(eq(threads.id, target.id));
    expect(row?.actMode).toBe("ask_first");
  });
});
