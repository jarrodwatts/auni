import { ASK_TOOL_NAMES, CARD_FORMAT, CARD_WAITS_MS, RETRACTED } from "@auni/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, jobs, threads } from "../db/schema.ts";
import { staleCardsJob } from "../jobs/action.ts";
import { waitingCardsContext } from "../conversation/context.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { FACE, stubRecipe } from "../test/recipe.ts";
import { queued } from "../test/jobs.ts";
import { decideActions, prepareLeg, recordActions } from "./actions.ts";
import { retractStale } from "./waiting.ts";
import { moneyTools } from "./tools.ts";

// Every money tool is this one stand-in, which sends USDC and says what the call asked it to.
const send = stubRecipe({
  input: { what: z.string() },
  direction: () => null,
  describe: async (input) => ({
    summary: String(input.what),
    amountUsd: "2.50",
    effect: { gives: [{ text: "$2.50 of USDC" }], gets: [], grants: [] },
  }),
});
vi.mock("./recipes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recipes: () => [send],
  recipeForTool: () => send,
  toolRecipe: () => send,
}));

beforeEach(() => wipe(threads, actions, jobs));

const statusOf = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0];
const said = (answer: CallToolResult) =>
  answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** A turn of the agent's in `threadId`, calling the money tool its card comes from. */
function turnIn(threadId: string) {
  const tool = (name: string) => moneyTools({ threadId }).find((t) => t.name === name)!;
  return {
    card: async (what: string, replaces?: readonly string[]) => {
      // A tool that throws reaches the agent as its error's words (agent/mcp.ts).
      const answer: CallToolResult = await tool("stock_trade")
        .handler({ what, ...(replaces ? { replaces } : {}) })
        .catch((error: unknown) => ({
          isError: true,
          content: [{ type: "text", text: (error as Error).message }],
        }));
      const id = (answer.structuredContent as { actionId?: string } | undefined)?.actionId;
      return { answer, id, said: said(answer) };
    },
    retract: (cards: readonly string[]) => tool("retract_cards").handler({ cards }),
  };
}

describe("a card that takes the place of others", () => {
  // The live test of 2026-11-14: in one turn the agent put up a withdrawal and a send of MON,
  // then one card doing both, and told the owner it replaced the two. Core replaced only cards
  // from an earlier turn, so all three waited, and the withdrawal stayed on Needs you for hours.
  it("must say which of its conversation's waiting cards it replaces, and those come off the table", async () => {
    const thread = await insertThread({ turnStartedAt: new Date(Date.now() - 60_000) });
    const turn = turnIn(thread.id);
    const withdraw = await turn.card("Withdraw $2.50 to your wallet on Monad", []);
    const mon = await turn.card("Send 1 MON to 0x97d2", []);

    // Naming nothing, the combined card is refused with the cards it could stand in for.
    const unsaid = await turn.card("Send 2.5 USDC and 1 MON to 0x97d2");
    expect(unsaid.answer.isError).toBe(true);
    expect(unsaid.said).toContain(`card ${withdraw.id}: Withdraw $2.50 to your wallet on Monad`);
    expect(unsaid.said).toContain(`card ${mon.id}: Send 1 MON to 0x97d2`);
    expect(await db.select().from(actions)).toHaveLength(2);

    const combined = await turn.card("Send 2.5 USDC and 1 MON to 0x97d2", [withdraw.id!, mon.id!]);
    expect(combined.said).toContain(
      `It replaces, and takes off the table: "Withdraw $2.50 to your wallet on Monad" (card ${withdraw.id}), "Send 1 MON to 0x97d2" (card ${mon.id}).`,
    );
    expect(await statusOf(withdraw.id!)).toMatchObject({ status: "replaced" });
    expect(await statusOf(mon.id!)).toMatchObject({ status: "replaced" });
    expect(await statusOf(combined.id!)).toMatchObject({ status: "awaiting_permission" });
    // A tap on a replaced card allows nothing.
    expect(await decideActions({ actionId: withdraw.id! }, "allow")).toEqual([]);
  });

  it("keeps them waiting beside it with [], and refuses a card that isn't waiting here", async () => {
    const thread = await insertThread();
    const elsewhere = await insertThread();
    const turn = turnIn(thread.id);
    const sell = await turn.card("Sell $5 of Nvidia", []);
    const there = await insertAction({ threadId: elsewhere.id, status: "awaiting_permission" });

    const beside = await turn.card("Send $5 to 0x97d2", []);
    expect(beside.answer.isError).toBeFalsy();
    expect(await statusOf(sell.id!)).toMatchObject({ status: "awaiting_permission" });

    // Another conversation's card is retract_cards', never a new card's here.
    const wrong = await turn.card("Send $6 to 0x97d2", [there.id]);
    expect(wrong.said).toContain(`no card waiting in this conversation has the id ${there.id}`);
    expect(await statusOf(there.id)).toMatchObject({ status: "awaiting_permission" });
  });

  it("needs no word while nothing waits, never counts an ask, and replaces named earlier plans", async () => {
    const thread = await insertThread();
    const ask = await insertAction({
      threadId: thread.id,
      tool: "set_thread_autonomy",
      status: "awaiting_permission",
    });
    const context = { threadId: thread.id };
    const plan = async (replaces?: readonly string[]) =>
      recordActions(
        context,
        [await prepareLeg(send, { what: "Buy Nvidia" })],
        crypto.randomUUID(),
        replaces,
      );
    // The ask is no money card to replace, so the first plan needs no `replaces`.
    const first = await plan();
    const second = await plan([first.rows[0]!.proposalId!]);
    expect(second.replaced).toEqual([{ id: first.rows[0]!.proposalId, asks: "Buy Nvidia" }]);
    expect(await statusOf(ask.id)).toMatchObject({ status: "awaiting_permission" });
  });
});

describe("retract_cards", () => {
  // The same live test: a "Move 30 MON to Arbitrum as ETH" card a later move made pointless,
  // which the agent twice told the owner, in other chats, to decline.
  it("takes back a card waiting in another conversation, which then says Auni took it back", async () => {
    const thread = await insertThread();
    const elsewhere = await insertThread();
    const stale = await insertAction({
      threadId: elsewhere.id,
      summary: "Move 30 MON from Monad to Arbitrum as ETH",
      status: "awaiting_permission",
    });
    const allowed = await insertAction({ threadId: elsewhere.id, status: "awaiting_permission" });
    await decideActions({ actionId: allowed.id }, "allow");

    // Its context names it by id, with the way to take it back.
    const context = await waitingCardsContext(thread.id);
    expect(context).toContain(
      `card ${stale.id} in "another thread": Move 30 MON from Monad to Arbitrum as ETH`,
    );
    expect(context).toContain("taken back with retract_cards");

    const answer = await turnIn(thread.id).retract([stale.id, allowed.id]);
    expect(said(answer)).toBe(
      `Taken back: "Move 30 MON from Monad to Arbitrum as ETH" (card ${stale.id}). Each now says Auni took it back. ${allowed.id} is no card still waiting: allowed, declined or ended already, or never one.`,
    );
    expect(await statusOf(stale.id)).toMatchObject({ status: "retracted", error: RETRACTED.agent });
    expect(await statusOf(allowed.id)).toMatchObject({ status: "running" });
    expect(await decideActions({ actionId: stale.id }, "allow")).toEqual([]);
    expect(await waitingCardsContext(thread.id)).toBeNull();
  });
});

describe("a card that waited a day", () => {
  const dayAgo = (ms = 0) => new Date(Date.now() - CARD_WAITS_MS - ms);

  it("is taken back, saying why, while a younger one waits on", async () => {
    const thread = await insertThread();
    const old = await insertAction({
      threadId: thread.id,
      status: "awaiting_permission",
      createdAt: dayAgo(60_000),
    });
    const young = await insertAction({
      threadId: thread.id,
      status: "awaiting_permission",
      createdAt: dayAgo(-60_000),
    });
    await staleCardsJob.run({}, {} as never);
    expect(await statusOf(old.id)).toMatchObject({ status: "retracted", error: RETRACTED.stale });
    expect(await statusOf(young.id)).toMatchObject({ status: "awaiting_permission" });
  });

  it("is never allowed by a tap that comes before the cron takes it back", async () => {
    const old = await insertAction({ status: "awaiting_permission", createdAt: dayAgo(1_000) });
    expect(await decideActions({ actionId: old.id }, "allow")).toEqual([]);
    expect(await statusOf(old.id)).toMatchObject({ status: "retracted", error: RETRACTED.stale });
    expect(await db.select().from(jobs)).toEqual([]);
  });
});

// A card from before an update may not show all its move grants (a first sale's lasting
// permission): Allow refuses it, so it is taken back as Auni starts and on the cron rather than
// sit there looking allowable, and the agent is told, so it can put the move up again.
describe("a card drawn before cards said all they say now", () => {
  it("is taken back as it was shown, saying why, and its thread is told", async () => {
    const thread = await insertThread();
    const card = FACE;
    const old = await insertAction({
      threadId: thread.id,
      status: "awaiting_permission",
      summary: "Sell half of the Fed bet",
      cardFormat: CARD_FORMAT - 1,
      card,
    });
    const fresh = await insertAction({ threadId: thread.id, status: "awaiting_permission" });
    const ask = await insertAction({
      threadId: thread.id,
      status: "awaiting_permission",
      tool: ASK_TOOL_NAMES[0],
      cardFormat: CARD_FORMAT - 1,
    });
    const done = await insertAction({ status: "done", cardFormat: CARD_FORMAT - 1 });
    expect(await db.transaction(retractStale)).toEqual([thread.id]);
    expect(await statusOf(old.id)).toMatchObject({
      status: "retracted",
      error: RETRACTED.outOfDate,
      card,
      cardFormat: CARD_FORMAT - 1,
    });
    for (const left of [fresh, ask])
      expect((await statusOf(left.id))?.status).toBe("awaiting_permission");
    expect((await statusOf(done.id))?.status).toBe("done");
    const [woke, ...more] = await queued("turn");
    expect(more).toEqual([]);
    expect(woke?.data).toMatchObject({ threadId: thread.id });
    expect(woke?.data.reason).toContain(`"Sell half of the Fed bet" (card ${old.id})`);
    // The card says what that wake is for, so the owner isn't asked for what Auni will do itself.
    expect(RETRACTED.outOfDate).toContain("Auni will put it up again");
    expect(RETRACTED.outOfDate).not.toMatch(/ask again/iu);
    // Once: the cron finds nothing more to take back or tell.
    await staleCardsJob.run({}, {} as never);
    expect(await queued("turn")).toHaveLength(1);
  });

  // Found in review: a wake keeps its first 4,000 characters, and a card's summary has no cap.
  it("names every card it took back, however long what one asked", async () => {
    const thread = await insertThread();
    const old = [];
    for (const summary of ["x".repeat(5_000), "Sell half of the Fed bet"])
      old.push(
        await insertAction({
          threadId: thread.id,
          status: "awaiting_permission",
          summary,
          cardFormat: CARD_FORMAT - 1,
        }),
      );
    await db.transaction(retractStale);
    const [woke] = await queued("turn");
    for (const card of old) expect(woke?.data.reason).toContain(card.id);
  });
});
