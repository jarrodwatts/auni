import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";
import { messages, threads } from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { listThreads } from "./threads.ts";

beforeEach(() => wipe(threads, messages));

const question = {
  type: "tool-suggest_replies",
  toolCallId: "call-1",
  state: "output-available",
  input: { question: "Want me to watch it?", options: [{ label: "Yes" }, { label: "No" }] },
  output: "Asked",
};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 12, minute));

/** The person's one listed thread's money in motion. */
async function moving() {
  const [thread] = await listThreads();
  return thread?.moving;
}

async function say(threadId: string, role: "user" | "assistant", parts: unknown[], minute: number) {
  await db.insert(messages).values({
    threadId,
    role,
    parts,
    createdAt: at(minute),
  });
}

describe("listThreads", () => {
  it("says which threads end on Auni's question, until the person answers it", async () => {
    const open = await insertThread();
    const answered = await insertThread();
    const settled = await insertThread();
    const offered = await insertThread();
    await say(open.id, "user", [{ type: "text", text: "Pearl?" }], 1);
    await say(open.id, "assistant", [question, { type: "text", text: "Here's Pearl." }], 2);
    await say(answered.id, "assistant", [question], 1);
    await say(answered.id, "user", [{ type: "text", text: "Yes" }], 2);
    await say(settled.id, "assistant", [question, { type: "data-cards", data: {} }], 1);
    const nextThings = { options: question.input.options };
    await say(offered.id, "assistant", [{ ...question, input: nextThings }], 1);

    const asking = Object.fromEntries((await listThreads()).map(({ id, asking }) => [id, asking]));
    expect(asking).toEqual({
      [open.id]: true,
      [answered.id]: false,
      [settled.id]: false,
      [offered.id]: false,
    });
  });

  it("counts a card's legs while any runs, and every running card in the thread together", async () => {
    const thread = await insertThread();
    await say(thread.id, "assistant", [{ type: "text", text: "Here's the plan." }], 1);
    const proposalId = randomUUID();
    const leg = (status: "running" | "done" | "failed") =>
      insertAction({ threadId: thread.id, proposalId, status, startedAt: at(3) });
    await Promise.all([leg("done"), leg("failed"), leg("running"), leg("running")]);
    await insertAction({ threadId: thread.id, status: "running", startedAt: at(4) });

    expect(await moving()).toEqual({ done: 1, failed: 1, total: 5 });
  });

  it("keeps a settled card on the row until the person reads past its start", async () => {
    const thread = await insertThread({ readAt: at(2) });
    await say(thread.id, "assistant", [{ type: "text", text: "Done." }], 1);
    const proposalId = randomUUID();
    await insertAction({
      threadId: thread.id,
      proposalId,
      status: "done",
      startedAt: at(3),
    });
    await insertAction({
      threadId: thread.id,
      proposalId,
      status: "done",
      startedAt: at(4),
    });

    expect(await moving()).toEqual({ done: 2, failed: 0, total: 2 });
    await db.update(threads).set({ readAt: at(5) });
    expect(await moving()).toBeNull();
  });

  it("says what a waiting card asks as its button does, with its money", async () => {
    const sell = await insertThread();
    const buy = await insertThread();
    const key = await insertThread();
    for (const thread of [sell, buy, key]) {
      await say(thread.id, "assistant", [{ type: "text", text: "Here it is." }], 1);
    }
    const face = (action: string) => ({
      title: action,
      action,
      working: action,
      context: "Will the Fed cut rates in December?",
      figures: [],
      finePrint: null,
      receipt: { title: action, detail: null, amount: null },
    });
    await insertAction({
      threadId: sell.id,
      status: "awaiting_permission",
      summary: 'Sell 310 Yes shares on "Will the Fed cut rates in December?"',
      amountUsd: "0",
      details: { returnsUsd: "201.50" },
      card: face("Sell Yes"),
    });
    await insertAction({
      threadId: buy.id,
      status: "awaiting_permission",
      amountUsd: "250",
      card: face("Buy {amount}"),
    });
    await insertAction({
      threadId: key.id,
      status: "awaiting_permission",
      tool: "request_secret",
      summary: "Elfa API key",
      amountUsd: "0",
      input: { field: "ELFA_API_KEY", app: "elfa", why: "To read what's being said" },
    });

    const lines = Object.fromEntries(
      (await listThreads()).map(({ id, moneyLine }) => [id, moneyLine]),
    );
    expect(lines).toEqual({
      [sell.id]: "Sell Yes, about $201.50 back",
      [buy.id]: "Buy $250",
      [key.id]: "Paste your Elfa key",
    });
  });

  it("leaves out a card that was declined, waits, or started before the person last read", async () => {
    const thread = await insertThread({ readAt: at(5) });
    await say(thread.id, "assistant", [{ type: "text", text: "Want it?" }], 1);
    await insertAction({ threadId: thread.id, status: "cancelled" });
    await insertAction({ threadId: thread.id, status: "awaiting_permission" });
    await insertAction({ threadId: thread.id, status: "failed", startedAt: at(3) });

    expect(await moving()).toBeNull();
  });

  it("calls an answer unread until the thread is read after it", async () => {
    const thread = await insertThread();
    await say(thread.id, "assistant", [{ type: "text", text: "Done." }], 1);
    const unread = async () => (await listThreads())[0]?.unread;

    expect(await unread()).toBe(false);
    await db.update(threads).set({ repliedAt: sql`now() - interval '1 minute'` });
    expect(await unread()).toBe(true);
    await db.update(threads).set({ readAt: sql`now()` });
    expect(await unread()).toBe(false);
  });
});
