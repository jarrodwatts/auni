import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import {
  actions,
  automationFires,
  automations,
  channelDeliveries,
  fills,
  jobs,
  messages,
  threads,
} from "../db/schema.ts";
import { turnKind } from "../jobs/kinds.ts";
import { readActivity } from "../money/activity.ts";
import { threadsRouter } from "../routes/threads.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { serve } from "../test/serve.ts";
import { mainChat, startChat } from "./places.ts";
import { conversationTools } from "./tools.ts";
import { endRecord } from "./turn-record.ts";

// No stock catalog to read for Activity's names.
vi.mock("../money/swaps/xstocks.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  xStockCatalog: async () => [],
}));

const url = serve(express().use("/threads", threadsRouter));

beforeEach(() => wipe(threads, messages, actions, fills, automations, automationFires, jobs));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** A chat with the owner's first message in it, last spoken in `minutes` ago. */
async function chat(
  title: string,
  minutes = 10,
  fields: Partial<typeof threads.$inferInsert> = {},
) {
  const thread = await insertThread({ title, updatedAt: minutesAgo(minutes), ...fields });
  await db.insert(messages).values({
    threadId: thread.id,
    role: "user",
    parts: [{ type: "text", text: title }],
    createdAt: minutesAgo(minutes),
  });
  return thread;
}

async function call(method: "PATCH" | "DELETE", threadId: string, body?: unknown) {
  const response = await fetch(url(`/threads/${threadId}`), {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : undefined) as { error?: string; message?: string },
  };
}

async function listed() {
  const response = await fetch(url("/threads"));
  const { threads: rows } = (await response.json()) as {
    threads: { id: string; title: string; archivedAt: string | null }[];
  };
  return rows;
}

async function search(query: string) {
  const response = await fetch(url(`/threads/search?q=${encodeURIComponent(query)}`));
  const { results } = (await response.json()) as { results: { thread: { id: string } }[] };
  return results.map(({ thread }) => thread.id);
}

/** A watch set in the thread. */
async function watch(threadId: string, status: "active" | "paused" | "triggered" = "active") {
  const [row] = await db
    .insert(automations)
    .values({
      threadId,
      source: "prices",
      condition: {},
      description: "ETH falls below $2,000",
      note: "Buy the dip",
      status,
    })
    .returning();
  return row!;
}

describe("renaming and configuring a thread", () => {
  it("keeps the owner's name, pinning, autonomy budget, and model selection", async () => {
    const thread = await chat("hey");
    expect((await call("PATCH", thread.id, { title: "Nvidia buys" })).status).toBe(200);
    expect((await listed()).find(({ id }) => id === thread.id)?.title).toBe("Nvidia buys");

    expect(
      (
        await call("PATCH", thread.id, {
          pinned: true,
          actMode: "within_limits",
          budgetUsd: "500",
          modelSelection: { brain: "claude-code", model: "opus", effort: "high" },
        })
      ).status,
    ).toBe(200);
    const [updated] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(updated).toMatchObject({
      actMode: "within_limits",
      budgetUsd: "500.00",
      modelSelection: { brain: "claude-code", model: "opus", effort: "high" },
    });
    expect(updated?.pinnedAt).toBeInstanceOf(Date);

    expect((await call("PATCH", thread.id, { pinned: false, actMode: "ask_first" })).status).toBe(
      200,
    );
    const [reset] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(reset).toMatchObject({ actMode: "ask_first", pinnedAt: null });
  });
});

describe("Auni naming a chat", () => {
  const nameChat = (threadId: string, name: string) =>
    conversationTools({ threadId })
      .find((tool) => tool.name === "name_chat")!
      .handler({ name });
  const titleOf = async (threadId: string) =>
    (await db.select().from(threads).where(eq(threads.id, threadId)))[0]?.title;

  it("names it once, while it still goes by its first message, and never over the owner's name", async () => {
    const started = await startChat("hey");
    await db.insert(messages).values({
      threadId: started.id,
      role: "user",
      parts: [{ type: "text", text: "hey" }],
    });
    expect((await nameChat(started.id, "Nvidia buy")).isError).toBeFalsy();
    expect(await titleOf(started.id)).toBe("Nvidia buy");
    expect((await nameChat(started.id, "Something else")).isError).toBe(true);
    expect(await titleOf(started.id)).toBe("Nvidia buy");

    const renamed = await chat("hello there");
    await call("PATCH", renamed.id, { title: "My own name" });
    expect((await nameChat(renamed.id, "Auni's name")).isError).toBe(true);
    expect(await titleOf(renamed.id)).toBe("My own name");
  });

  it("names the main conversation Auni started before any message", async () => {
    const main = await mainChat(db);
    expect((await nameChat(main.id, "Daily brief")).isError).toBeFalsy();
    expect(await titleOf(main.id)).toBe("Daily brief");
  });
});

describe("archiving a chat", () => {
  it("takes it out of History, keeps it in search, and brings it back", async () => {
    const thread = await chat("Buy $250 of Nvidia");
    expect((await call("PATCH", thread.id, { archived: true })).status).toBe(200);
    expect((await listed()).find(({ id }) => id === thread.id)?.archivedAt).not.toBeNull();
    expect(await search("nvidia")).toEqual([thread.id]);

    await call("PATCH", thread.id, { archived: false });
    expect((await listed()).find(({ id }) => id === thread.id)?.archivedAt).toBeNull();
  });

  it("is refused while a card waits there, or a held move needs the owner, in words", async () => {
    const waiting = await chat("Buy $250 of Nvidia");
    await insertAction({ threadId: waiting.id, status: "awaiting_permission" });
    const held = await chat("Close my bitcoin long");
    await insertAction({ threadId: held.id, status: "running", phase: "needs_owner" });

    for (const thread of [waiting, held]) {
      const refused = await call("PATCH", thread.id, { archived: true });
      expect(refused).toMatchObject({ status: 409, body: { error: "card_waiting" } });
      expect(refused.body.message).toContain("waits for your answer");
      expect((await listed()).find(({ id }) => id === thread.id)?.archivedAt).toBeNull();
    }
  });

  it("allows a move still landing: Auni's word on it brings the chat back", async () => {
    const thread = await chat("Stake 60 of my MON");
    await insertAction({ threadId: thread.id, status: "running", startedAt: minutesAgo(1) });
    expect((await call("PATCH", thread.id, { archived: true })).status).toBe(200);

    // The move lands and its turn leaves an answer, as a watch's or the brief's would.
    await db.transaction((tx) =>
      endRecord(
        tx,
        thread.id,
        { turn: randomUUID(), began: new Date().toISOString() },
        { replied: true },
      ),
    );
    const [back] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(back?.archivedAt).toBeNull();
    expect(back?.repliedAt).not.toBeNull();
  });

  it("leaves it archived after a quiet answer, which tells the owner nothing", async () => {
    const thread = await chat("Watch ETH for me");
    await call("PATCH", thread.id, { archived: true });
    await db.transaction((tx) =>
      endRecord(tx, thread.id, { turn: randomUUID(), began: new Date().toISOString() }),
    );
    const [still] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(still?.archivedAt).not.toBeNull();
  });

  it("moves where Auni speaks up unasked (the brief, news) to the latest chat still listed", async () => {
    const older = await chat("How am I doing?", 30);
    const latest = await chat("Buy $250 of Nvidia", 5);
    expect((await mainChat(db)).id).toBe(latest.id);
    await call("PATCH", latest.id, { archived: true });
    expect((await mainChat(db)).id).toBe(older.id);
  });
});

describe("deleting a chat", () => {
  it("removes its words for good, and every money record made in it stays as it was", async () => {
    const thread = await chat("Buy $250 of Nvidia");
    const done = await insertAction({
      threadId: thread.id,
      status: "done",
      startedAt: minutesAgo(5),
    });
    await db.insert(fills).values({
      actionId: done.id,
      instrument: "NVDA",
      chain: "monad",
      side: "buy",
      quantity: "1.4388",
      usdValue: "250",
    });
    await insertAction({ threadId: thread.id, status: "failed", startedAt: minutesAgo(4) });
    await insertAction({ threadId: thread.id, status: "cancelled" });
    const ended = await watch(thread.id, "triggered");
    await db.insert(automationFires).values({
      automationId: ended.id,
      eventId: "fire-1",
      payload: {},
      happenedAt: minutesAgo(3),
      verdict: "wake",
    });
    await db
      .insert(channelDeliveries)
      .values({ channel: "telegram", ref: "1", threadId: thread.id });
    const before = await readActivity(null);

    expect((await call("DELETE", thread.id)).status).toBe(204);

    expect(await db.select().from(threads).where(eq(threads.id, thread.id))).toEqual([]);
    expect(await db.select().from(messages).where(eq(messages.threadId, thread.id))).toEqual([]);
    expect(await db.select().from(automations)).toEqual([]);
    expect(await db.select().from(channelDeliveries)).toEqual([]);
    const kept = await db.select().from(actions);
    expect(kept).toHaveLength(3);
    expect(kept.every(({ threadId }) => threadId === null)).toBe(true);
    expect(await db.select().from(fills)).toHaveLength(1);
    expect(await readActivity(null)).toEqual({
      ...before,
      items: before.items.map((item) => ({
        ...item,
        threadId: null,
        subtitle: item.subtitle.replace("Buy $250 of Nvidia", "Auni"),
      })),
    });
  });

  it("is refused while a card waits there, or a move is still landing", async () => {
    const waiting = await chat("Buy $250 of Nvidia");
    await insertAction({ threadId: waiting.id, status: "awaiting_permission" });
    const landing = await chat("Stake 60 of my MON");
    await insertAction({ threadId: landing.id, status: "running", startedAt: minutesAgo(1) });

    expect(await call("DELETE", waiting.id)).toMatchObject({
      status: 409,
      body: { error: "card_waiting" },
    });
    expect(await call("DELETE", landing.id)).toMatchObject({
      status: 409,
      body: { error: "move_landing" },
    });
    expect(await listed()).toHaveLength(2);
  });

  it("is refused while a watch would wake it, naming the watch", async () => {
    const thread = await chat("Tell me if ETH dips");
    await watch(thread.id, "paused");
    const refused = await call("DELETE", thread.id);
    expect(refused).toMatchObject({ status: 409, body: { error: "watching" } });
    expect(refused.body.message).toContain("ETH falls below $2,000");
  });

  it("is refused while Auni still has something to tell there: a turn queued, a fire held for the brief", async () => {
    const woken = await chat("Stake 60 of my MON");
    await turnKind.enqueue(db, { threadId: woken.id, reason: "Your stake landed." });
    const briefed = await chat("Tell me if ETH dips");
    const ended = await watch(briefed.id, "triggered");
    await db.insert(automationFires).values({
      automationId: ended.id,
      eventId: "fire-1",
      payload: {},
      happenedAt: minutesAgo(3),
      verdict: "brief",
    });

    for (const thread of [woken, briefed])
      expect(await call("DELETE", thread.id)).toMatchObject({
        status: 409,
        body: { error: "still_telling" },
      });

    // Once the turn has run, the chat can go.
    await db.update(jobs).set({ finishedAt: sql`now()`, outcome: "done" });
    expect((await call("DELETE", woken.id)).status).toBe(204);
  });
});
