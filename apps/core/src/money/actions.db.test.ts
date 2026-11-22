import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { actionWireSchema, HELD } from "@auni/shared";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, fills, jobs, threads } from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { actionKind, turnKind } from "../jobs/kinds.ts";
import { queued } from "../test/jobs.ts";
import { stubRecipe } from "../test/recipe.ts";
import {
  actionWire,
  decideActions,
  executeAction,
  prepareLeg,
  proposeAction,
  recordActions,
} from "./actions.ts";
import { APPROVED_SALE_OF } from "./approved.ts";
import { QUANTITY_DECIMALS } from "./fill-key.ts";
import { MayHaveSent, NothingMoved, type Recipe } from "./recipe.ts";
import { parseUnits } from "./usd.ts";
import type { SignerOptions } from "./wallets.ts";

// Every tool resolves to `buy`, so no venue is called, and wallets are a stub rather than a wallet app's read.
const lookup = vi.hoisted(() => ({ recipe: undefined as unknown }));
vi.mock("./recipes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recipeForTool: () => lookup.recipe,
}));
// What a sale's holding reads as just before it runs.
const held = vi.hoisted(() => ({ units: null as bigint | null }));
vi.mock("./portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  heldNow: async () => held.units,
}));
// What the action hands the wallet that signs for it.
const signing = vi.hoisted(() => ({ options: undefined as SignerOptions | undefined }));
vi.mock("./wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  signerFor: async (options: SignerOptions) => {
    signing.options = options;
    return {};
  },
}));

let executions = 0;
const buy = stubRecipe({
  describe: async (input) => ({
    summary: `Buy $${String(input.usd)} of Nvidia`,
    amountUsd: String(input.usd),
    // Cash for shares, both in the wallet: a buy a specialist can make on its own.
    effect: {
      gives: [{ text: `$${String(input.usd)} of USDC` }],
      gets: [{ text: "NVDAx" }],
      grants: [],
    },
  }),
  execute: async () => {
    executions += 1;
    // Long enough that every concurrent caller reaches its claim while this one runs.
    await sleep(50);
    return {
      txs: [{ chain: "base", hash: "0xabc" }],
      fills: [{ chain: "base", instrument: "nvda", side: "buy", quantity: "1", usdValue: "10" }],
    };
  },
});
lookup.recipe = buy;

beforeEach(async () => {
  executions = 0;
  await wipe(threads, actions, fills);
});

const actionRow = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0];

describe("executeAction", () => {
  it("runs an action once however many deliveries claim it at the same time", async () => {
    const { id } = await insertAction({ input: { usd: "10" } });
    await Promise.all(Array.from({ length: 5 }, () => executeAction(id)));
    expect(executions).toBe(1);
    expect(await actionRow(id)).toMatchObject({ status: "done", txs: [{ hash: "0xabc" }] });
    expect(await db.select().from(fills).where(eq(fills.actionId, id))).toHaveLength(1);
  });

  it("records a move its card showed coming later, allowed by its tap, to run by itself then", async () => {
    // A bridge out of Solana: its card says the SOL Circle holds comes back in five days.
    const thread = await insertThread();
    const { id } = await insertAction({ input: { usd: "10" }, threadId: thread.id });
    const at = new Date(Date.now() + 5 * 24 * 60 * 60_000);
    lookup.recipe = {
      ...buy,
      execute: async () => ({
        txs: [{ chain: "solana", hash: "deposit" }],
        fills: [],
        later: [{ tool: "across_reclaim", input: { account: "acct" }, summary: "Get back", at }],
      }),
    };
    try {
      await Promise.all([executeAction(id), executeAction(id)]);
    } finally {
      lookup.recipe = buy;
    }
    const later = await db
      .select()
      .from(actions)
      .where(sql`${actions.details}->>'after' = ${id}`);
    expect(later).toEqual([
      expect.objectContaining({
        status: "running",
        phase: "queued",
        // Its card said it already: it wakes no thread when it settles.
        threadId: null,
        summary: "Get back",
        amountUsd: "0.00",
        input: { account: "acct" },
        details: { after: id },
      }),
    ]);
    // Its own job, due then, not before.
    const [job] = await db
      .select({ runAt: jobs.runAt })
      .from(jobs)
      .where(sql`${jobs.data}->>'actionId' = ${later[0]!.id}`);
    expect(job?.runAt.getTime()).toBe(at.getTime());
  });

  // A done move reads as money moved everywhere (a specialist's moves, the activity).
  it("fails a run that sent something but knows nothing moved, keeping what it sent", async () => {
    const { id } = await insertAction({ input: { usd: "10" } });
    lookup.recipe = {
      ...buy,
      execute: async ({ recordSent }) => {
        await recordSent({ chain: "monad", hash: "0xdef" });
        throw new NothingMoved("Not filled within a minute; nothing left the wallet.");
      },
    } satisfies Recipe;
    try {
      expect(await executeAction(id)).toMatchObject({
        status: "failed",
        error: "Not filled within a minute; nothing left the wallet.",
        failureKind: "unfilled",
        txs: [{ chain: "monad", hash: "0xdef" }],
      });
    } finally {
      lookup.recipe = buy;
    }
  });

  // Its error reaches the agent's wake, the card and a channel, and a node's link can carry a key.
  it("keeps why it failed with no link the error quoted, only its host", async () => {
    const { id } = await insertAction({ input: { usd: "10" } });
    lookup.recipe = {
      ...buy,
      execute: async () => {
        throw new Error("HTTP request failed. Status: 500 URL: https://rpc.example/v2/KEY123456");
      },
    } satisfies Recipe;
    try {
      expect((await executeAction(id)).error).toBe(
        "HTTP request failed. Status: 500 URL: rpc.example",
      );
    } finally {
      lookup.recipe = buy;
    }
  });

  // Failed would offer "Try again", and a second send of one that went. Nothing it kept can be
  // read, so it is held for the owner at once (money/held.db.test.ts follows it from there).
  it("holds a send whose answer never came back, with nothing else sent", async () => {
    const { id } = await insertAction({ input: { usd: "10" } });
    lookup.recipe = {
      ...buy,
      execute: async () => {
        throw new MayHaveSent({ chain: "solana" }, "The wallet", new Error("socket hang up"));
      },
    } satisfies Recipe;
    try {
      expect(await executeAction(id)).toMatchObject({
        status: "running",
        phase: "needs_owner",
        error: HELD.unanswered,
        txs: [{ chain: "solana" }],
      });
    } finally {
      lookup.recipe = buy;
    }
  });

  it("is landing from the write that records its send, with what its run noted, its card's details untouched", async () => {
    const { id } = await insertAction({ input: { usd: "10" }, details: { arrivesOn: "Base" } });
    lookup.recipe = {
      ...buy,
      execute: async () => ({
        txs: [{ chain: "monad", hash: "0xdeposit" }],
        fills: [],
        run: { lands: "$10.00 on Base", nonce: "7" },
      }),
    } satisfies Recipe;
    try {
      expect(await executeAction(id)).toMatchObject({
        status: "running",
        phase: "landing",
        txs: [{ chain: "monad", hash: "0xdeposit" }],
        details: { arrivesOn: "Base" },
        run: { lands: "$10.00 on Base", nonce: "7" },
      });
    } finally {
      lookup.recipe = buy;
    }
  });

  // A wallet's journal and the action's record of a send commit together or not at all.
  it("keeps a send a wallet reports within its own write only if that write commits", async () => {
    const { id } = await insertAction({ input: { usd: "10" } });
    lookup.recipe = {
      ...buy,
      execute: async () => {
        const { onSent } = signing.options!;
        await db
          .transaction(async (within) => {
            await onSent({ chain: "base", hash: "0xdead", walletTxId: "lost" }, within);
            throw new Error("The worker died before the journal committed.");
          })
          .catch(() => {});
        await db.transaction((within) =>
          onSent({ chain: "base", hash: "0xabc", walletTxId: "kept" }, within),
        );
        return buy.execute(undefined as never);
      },
    } satisfies Recipe;
    try {
      expect((await executeAction(id)).txs).toEqual([
        { chain: "base", hash: "0xabc", walletTxId: "kept" },
      ]);
    } finally {
      lookup.recipe = buy;
    }
  });

  // Whatever its recipe, so no venue can forget to ask (see step-up.ts).
  it("sends nothing whose card takes the owner's proof until it was recorded", async () => {
    const somewhereNew = "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2";
    const { id } = await insertAction({
      input: { usd: "10" },
      details: { leavesTo: somewhereNew },
    });
    expect(await executeAction(id)).toMatchObject({
      error: "Auni never checked it was you allowing this one, so nothing was sent.",
    });
    expect(executions).toBe(0);
  });

  it("sends one whose card takes the owner's proof once it was recorded", async () => {
    const { id } = await insertAction({
      input: { usd: "10" },
      details: { leavesTo: "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2" },
      stepUpAt: new Date(),
    });
    expect(await executeAction(id)).toMatchObject({ status: "done" });
    expect(executions).toBe(1);
  });

  it("hands a replayed delivery the finished row and changes nothing", async () => {
    const { id } = await insertAction({ input: { usd: "10" } });
    const finished = await executeAction(id);
    expect(await executeAction(id)).toEqual(finished);
    expect(await actionRow(id)).toEqual(finished);
    expect(executions).toBe(1);
  });
});

describe("proposeAction", () => {
  it("queues a move of a holding it runs on its own, so it waits on other moves of that holding", async () => {
    const own = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const nvidia: Recipe = {
      ...buy,
      about: () => ({ kind: "token", chain: "solana", mint: "nvda", stock: true, buysUsd: 10 }),
    };
    lookup.recipe = nvidia;
    try {
      const outcome = await proposeAction({ threadId: own.id }, nvidia, { usd: "10" });
      expect(outcome.status).toBe("running");
      expect(executions).toBe(0);
      expect(await queued("action")).toEqual([
        expect.objectContaining({
          key: `action-${outcome.action.id}-a1`,
          lanes: [outcome.action.id, "holding:solana:nvda"],
        }),
      ]);
    } finally {
      lookup.recipe = buy;
    }
  });
  // Aave's supply, say: no venue lane and no holding, yet its job is what tells the thread.
  it("queues a lone move in lanes of its own too, rather than running it in the tool call", async () => {
    const own = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const outcome = await proposeAction({ threadId: own.id }, buy, { usd: "10" });
    expect(outcome.status).toBe("running");
    expect(executions).toBe(0);
    const { id } = outcome.action;
    expect(await queued("action")).toEqual([
      expect.objectContaining({ key: `action-${id}-a1`, lanes: [id, `holding:${id}`] }),
    ]);
  });
});

describe("recordActions", () => {
  it("lets only one of two plans spend the same free cash on its own; the other asks", async () => {
    const own = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const context = { threadId: own.id };
    const plan = async () => recordActions(context, [await prepareLeg(buy, { usd: "60" })], null);
    await Promise.all([plan(), plan()]);
    const recorded = await db
      .select({ status: actions.status })
      .from(actions)
      .where(eq(actions.threadId, own.id));
    expect(recorded.map((row) => row.status).sort()).toEqual(["awaiting_permission", "running"]);
  });

  it("acts on its own only in an active Auto thread with a positive budget", async () => {
    const places = [
      await insertThread({ actMode: "ask_first", budgetUsd: "100" }),
      await insertThread({ actMode: "within_limits", budgetUsd: "0" }),
      await insertThread({ actMode: "within_limits", budgetUsd: "100", archivedAt: new Date() }),
      null,
    ];
    for (const thread of places) {
      const context = { threadId: thread?.id ?? null };
      const { rows } = await recordActions(context, [await prepareLeg(buy, { usd: "10" })], null);
      expect(rows[0]?.status).toBe("awaiting_permission");
    }
    const own = await insertThread({ budgetUsd: "100", actMode: "within_limits" });
    const { rows } = await recordActions(
      { threadId: own.id },
      [await prepareLeg(buy, { usd: "10" })],
      null,
    );
    expect(rows[0]?.status).toBe("running");
  });

  it("reads what a sale sells just before it runs, writes the sale to whoever held it, and lowers an auto thread's budget", async () => {
    const ai = await insertThread({ actMode: "within_limits", budgetUsd: "100" });
    const other = await insertThread();
    const bought = await insertAction({
      threadId: ai.id,
      status: "done",
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    await db.insert(fills).values({
      actionId: bought.id,
      threadId: ai.id,
      chain: "base",
      instrument: "nvda",
      side: "buy",
      quantity: "10",
      usdValue: "100",
    });
    // The wallet holds 10, all AI's, and another thread sells 4 of them.
    held.units = parseUnits("10", QUANTITY_DECIMALS);
    lookup.recipe = {
      ...buy,
      execute: async () => ({
        txs: [{ chain: "base", hash: "0xsell" }],
        fills: [{ chain: "base", instrument: "nvda", side: "sell", quantity: "4", usdValue: "40" }],
      }),
    };
    const { id } = await insertAction({
      threadId: other.id,
      input: { usd: "0" },
      details: { [APPROVED_SALE_OF]: "base:nvda" },
    });
    try {
      await executeAction(id);
    } finally {
      lookup.recipe = buy;
    }
    expect(
      await db
        .select({ threadId: fills.threadId })
        .from(fills)
        .where(eq(fills.actionId, id)),
    ).toEqual([{ threadId: ai.id }]);
    const [after] = await db.select().from(threads).where(eq(threads.id, ai.id));
    expect(after?.budgetUsd).toBe("60.00");
  });
});

describe("actionWire", () => {
  // The web's receipt and plan, a channel's leg and the agent each read how far a run has got
  // from the wire alone.
  it("says how far a running move has got, and what its run noted", async () => {
    const row = await insertAction({ phase: "landing", run: { lands: "$5.00 on Base" } });
    expect(actionWireSchema.parse(actionWire(row))).toMatchObject({
      status: "running",
      phase: "landing",
      run: { lands: "$5.00 on Base" },
    });
  });
});

describe("decideActions", () => {
  it("moves a waiting action once: a repeated or contrary tap changes nothing", async () => {
    const { id } = await insertAction({ status: "awaiting_permission" });
    const taps = await Promise.all([
      decideActions({ actionId: id }, "allow"),
      decideActions({ actionId: id }, "allow"),
    ]);
    expect(taps.flat()).toHaveLength(1);
    expect(await decideActions({ actionId: id }, "decline")).toEqual([]);
    expect(await actionRow(id)).toMatchObject({ status: "running" });
    expect(await queued("action")).toEqual([
      expect.objectContaining({
        key: `action-${id}-a1`,
        data: expect.objectContaining({ actionId: id }),
      }),
    ]);
  });

  // Allowing and queueing commit together: an allowed move with nothing to run it can't be.
  it("leaves the move waiting for the tap, with nothing queued, when its job can't be queued", async () => {
    const { id } = await insertAction({ status: "awaiting_permission" });
    const enqueue = vi.spyOn(actionKind, "enqueue").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(decideActions({ actionId: id }, "allow")).rejects.toThrow("disk full");
    } finally {
      enqueue.mockRestore();
    }
    expect(await actionRow(id)).toMatchObject({ status: "awaiting_permission" });
    expect(await queued()).toEqual([]);

    await decideActions({ actionId: id }, "allow");
    expect(await actionRow(id)).toMatchObject({ status: "running", startedAt: null });
    expect(await queued("action")).toHaveLength(1);
  });

  it("queues a proposal's first stage only, its legs one lane each", async () => {
    const proposalId = randomUUID();
    const legs = await Promise.all(
      ["a", "b"].map(() => insertAction({ status: "awaiting_permission", proposalId })),
    );
    await decideActions({ proposalId }, "allow");
    expect((await queued("action")).map(({ data }) => data.actionId).toSorted()).toEqual(
      legs.map(({ id }) => id).toSorted(),
    );
  });

  // Declining and waking commit together: the agent always hears of a no, and of no other.
  it("wakes a declined card's thread in the transaction that declines it", async () => {
    const thread = await insertThread();
    const { id } = await insertAction({
      status: "awaiting_permission",
      threadId: thread.id,
      summary: "Buy $10 of NVDA",
    });
    const enqueue = vi.spyOn(turnKind, "enqueue").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(decideActions({ actionId: id }, "decline")).rejects.toThrow("disk full");
    } finally {
      enqueue.mockRestore();
    }
    expect(await actionRow(id)).toMatchObject({ status: "awaiting_permission" });

    await decideActions({ actionId: id }, "decline");
    await decideActions({ actionId: id }, "decline");
    expect(await actionRow(id)).toMatchObject({ status: "cancelled" });
    expect(await queued()).toEqual([
      expect.objectContaining({
        kind: "turn",
        data: {
          threadId: thread.id,
          reason: `The owner declined action ${id} (Buy $10 of NVDA).`,
        },
      }),
    ]);
  });

  it("wakes a declined proposal's thread once, naming each leg", async () => {
    const thread = await insertThread();
    const proposalId = randomUUID();
    for (const summary of ["Sell SOL", "Buy ETH"])
      await insertAction({
        status: "awaiting_permission",
        threadId: thread.id,
        proposalId,
        summary,
      });
    await decideActions({ proposalId }, "decline");
    const wakes = await queued("turn");
    expect(wakes).toHaveLength(1);
    expect(String(wakes[0]!.data.reason)).toMatch(
      new RegExp(
        `^The owner declined proposal ${proposalId}: (Sell SOL; Buy ETH|Buy ETH; Sell SOL)\\.$`,
        "u",
      ),
    );
  });
});
