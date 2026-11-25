import { rmSync } from "node:fs";

import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { toolsFor } from "../../agent/mcp.ts";
import { routineBodySchema, routineDescriptionSchema, routinesDir } from "../../agent/routines.ts";
import { hashOf, legsDigest, syncCards } from "../../channels/cards.ts";
import { deliver, listenOnChannels, mintChannelPairing, receive } from "../../channels/hub.ts";
import { publishThreadEvent } from "../../conversation/stream.ts";
import { mainChat } from "../../conversation/places.ts";
import { db } from "../../db/client.ts";
import {
  actions,
  channelDeliveries,
  channelLinks,
  fills,
  jobs,
  messages,
  ownerSessions,
  threads,
  type ActionRow,
  type ThreadRow,
} from "../../db/schema.ts";
import { env } from "../../env.ts";
import { executeAction } from "../../money/actions.ts";
import { type Holding, portfolioNow } from "../../money/portfolio.ts";
import { allowAction } from "../../money/decide.ts";
import { insertAction, insertThread, wipe } from "../../test/db.ts";
import { queued } from "../../test/jobs.ts";
import { FACE, stubRecipe } from "../../test/recipe.ts";
import { FAKE_TOKEN, FakeBotApi } from "./fake-bot-api.ts";

// The agent must never be able to allow its own card, from any channel. Each row below is one
// way it, or someone who isn't the owner, might try; every one leaves the card waiting with no
// signer call, while the owner's own press from their direct chat runs it.

// Every move is a stub buy, so nothing calls a venue; the signer is counted, never real.
vi.mock("../../money/recipes/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recipeForTool: () => buy,
}));
const signer = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../money/wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  signerFor: async () => {
    signer.calls += 1;
    return {};
  },
}));
const funding = vi.hoisted(() => ({ needUsd: null as string | null }));
vi.mock("../../money/funding.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  proposalFunding: async () =>
    funding.needUsd ? { chain: "base", needUsd: funding.needUsd } : null,
}));

vi.mock("../../money/portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  portfolioNow: vi.fn(),
}));

const buy = stubRecipe({
  execute: async () => ({ txs: [{ chain: "base", hash: "0xabc" }], fills: [] }),
});

const OWNER = 4242;
const STRANGER = 777;
const GROUP = -1001;

const fake = new FakeBotApi();
let listening: AbortController;
let thread: ThreadRow;

beforeAll(async () => {
  process.env.TELEGRAM_API_URL = await fake.start();
  process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_API_URL;
  await fake.stop();
});

beforeEach(async () => {
  await wipe(threads, messages, actions, channelDeliveries, jobs, ownerSessions);
  signer.calls = 0;
  funding.needUsd = null;
  fake.calls.length = 0;
  // Each test talks to a bot of its own, whose message ids start from the beginning.
  fake.useBot(FAKE_TOKEN);
  listening = new AbortController();
  void listenOnChannels(listening.signal);
  thread = await insertThread();
  const pairing = await mintChannelPairing("telegram");
  fake.message({ from: OWNER }, `/start ${pairing!.code}`);
  await fake.handled();
});
afterEach(() => listening.abort());

/** A turn's answer, stored and then sent to Telegram as the deliver job queued with it sends it. */
async function answer(threadId: string, parts: unknown[]): Promise<void> {
  const [stored] = await db
    .insert(messages)
    .values({ threadId, role: "assistant", parts })
    .returning({ id: messages.id });
  await deliver({ channel: "telegram", threadId, messageId: stored!.id });
}

/** Runs every move the tap queued, as the worker would: only these reach the signer. */
async function runQueued(): Promise<void> {
  const moves = await queued("action");
  // Run once: the next call finds only what was queued since.
  await db.delete(jobs).where(eq(jobs.kind, "action"));
  for (const { data } of moves) await executeAction(String(data.actionId));
}

const statusOf = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0]!.status;

/** A move waiting for the owner, as a money tool records it. */
const waiting = (fields: Partial<ActionRow> = {}) =>
  insertAction({
    threadId: thread.id,
    status: "awaiting_permission",
    lines: [{ label: "You give", value: "10 USDC" }],
    ...fields,
  });

/** An ask waiting for the owner: to let a thread act on its own (see asks.ts). */
async function waitingAsk(): Promise<ActionRow> {
  const target = await insertThread();
  return waiting({
    tool: "set_thread_autonomy",
    venue: null,
    amountUsd: "0",
    threadId: target.id,
    input: { thread_id: target.id, act_mode: "within_limits", budget_usd: "100.00" },
    lines: [
      { label: "How it acts", value: "Buy and sell within its $100.00 budget without asking you." },
    ],
  });
}

/** How every thread acts now: an ask allowed would have changed it. */
const actModes = async () => (await db.select().from(threads)).map((row) => row.actMode);

/** The card core sealed for it, in an answer the owner's Telegram message asked for. */
async function deliverCard(action: ActionRow): Promise<void> {
  await deliverWire({
    kind: action.venue === null ? "ask" : "action",
    actionReference: action.id,
    title: action.summary,
  });
}

/** A plan's card, for legs of one proposal, as deliverCard sends a lone move's. */
const deliverPlan = (proposalId: string) =>
  deliverWire({ kind: "action_plan", proposalId, title: "A plan" });

async function deliverWire(card: Record<string, unknown>): Promise<void> {
  fake.message({ from: OWNER }, "Buy some Nvidia");
  await fake.handled();
  const [asked] = await db
    .select()
    .from(messages)
    .where(eq(messages.role, "user"))
    .orderBy(messages.createdAt);
  await answer(asked!.threadId, [
    { type: "text", text: "Here it is." },
    { type: "data-cards", data: { cards: [card] } },
  ]);
}

/** The grant on the Allow button of the newest card sent, or redrawn. */
function grantOnCard(): string {
  const card = fake.calls
    .filter(({ method }) => method === "sendMessage" || method === "editMessageText")
    .map(({ params }) => params)
    .findLast((params) => JSON.stringify(params.reply_markup ?? "").includes("allow:"));
  const markup = card!.reply_markup as { inline_keyboard: { callback_data?: string }[][] };
  return markup.inline_keyboard[0]![0]!.callback_data!.slice("allow:".length);
}

async function deliveryOf(actionId: string) {
  const [delivery] = await db
    .select()
    .from(channelDeliveries)
    .where(eq(channelDeliveries.actionId, actionId));
  return delivery!;
}

/** The Telegram message id of a card's delivery. */
const messageIdOf = async (actionId: string) =>
  Number((await deliveryOf(actionId)).ref.split(":").at(-1));

async function press(
  person: { from: number; chat?: number; chatType?: "group" },
  messageId: number,
  data: string,
) {
  const id = fake.press(person, messageId, data);
  await fake.handled();
  await runQueued();
  return fake.sent("answerCallbackQuery").find((answer) => answer.callback_query_id === id)
    ?.text as string | undefined;
}

describe("pairing", () => {
  it("makes the code's sender the owner here, once, and tells them in their chat", async () => {
    const [link] = await db.select().from(channelLinks);
    expect(link).toMatchObject({ owner: String(OWNER), chat: String(OWNER), pairingHash: null });
    // Sent as the pairing lands, before anything else is said there.
    expect(fake.sent("sendMessage")).toEqual([
      expect.objectContaining({
        chat_id: String(OWNER),
        text: expect.stringContaining("paired with Auni"),
      }),
    ]);
  });

  it("answers Telegram's own /start and /help itself: the agent never hears them", async () => {
    const spent = await mintChannelPairing("telegram");
    fake.message({ from: OWNER }, `/start ${spent!.code}`);
    await fake.handled();
    fake.calls.length = 0;
    // Telegram's Start button, its command, a link whose code was spent, and the bot's help.
    for (const text of ["/start", "/help", `/start ${spent!.code}`, "/start not-a-code"])
      fake.message({ from: OWNER }, text);
    // Anyone else hears nothing, as for anything else they send.
    fake.message({ from: STRANGER }, "/start");
    fake.message({ from: STRANGER }, "/help");
    await fake.handled();
    expect(await db.select().from(messages)).toEqual([]);
    expect(await queued("turn")).toEqual([]);
    expect(fake.sent("sendMessage")).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          chat_id: String(OWNER),
          text: expect.stringContaining("Send a take, or reply to any message"),
        }),
      ),
    );
  });

  it("ignores a code sent in a group, a spent code and a stale one", async () => {
    const ownerNow = async () => (await db.select().from(channelLinks))[0]?.owner;
    const pairing = await mintChannelPairing("telegram");
    fake.message({ from: STRANGER, chat: GROUP, chatType: "group" }, `/start ${pairing!.code}`);
    await fake.handled();
    expect(await ownerNow()).toBe(String(OWNER));

    // Spent by the owner's new device, so a second sender gets nothing from it.
    fake.message({ from: 5150 }, `/start ${pairing!.code}`);
    fake.message({ from: STRANGER }, `/start ${pairing!.code}`);
    await fake.handled();
    expect(await ownerNow()).toBe("5150");

    const stale = await mintChannelPairing("telegram");
    await db.update(channelLinks).set({ pairingExpiresAt: new Date(Date.now() - 1_000) });
    fake.message({ from: STRANGER }, `/start ${stale!.code}`);
    await fake.handled();
    expect(await ownerNow()).toBe("5150");
  });

  it("takes the owner's own new code as pairing again, never as a message to the agent", async () => {
    const pairing = await mintChannelPairing("telegram");
    fake.message({ from: OWNER }, `/start ${pairing!.code}`);
    await fake.handled();
    expect(await db.select().from(messages)).toEqual([]);
    expect(fake.sent("sendMessage").at(-1)?.text).toContain("paired with Auni");
  });

  it("resends tap cards and held moves only to the owner, with proof kept in the app", async () => {
    const first = await waiting({ summary: "Buy Nvidia" });
    const second = await waiting({ summary: "Buy Tesla" });
    const held = await waiting({
      summary: "Existing order",
      status: "running",
      phase: "needs_owner",
    });
    const proof = await waiting({
      summary: "Withdrawal",
      tool: "withdraw_usdc",
      details: { leavesTo: "0x5b7a3f0e2c9d41a8b6e0f7c2d9a4b1e3f6c8d0a2" },
    });
    await waiting({ summary: "Unpublished order", status: "running", phase: "needs_owner" });
    const unpublished = await waiting({ summary: "A card the turn hasn't shown yet" });
    await db.insert(messages).values({
      threadId: thread.id,
      role: "assistant",
      parts: [
        {
          type: "data-cards",
          data: {
            cards: [first, second, held, proof].map((action) => ({
              kind: "action",
              actionReference: action.id,
              title: action.summary,
            })),
          },
        },
      ],
    });
    fake.calls.length = 0;
    fake.message({ from: STRANGER }, "/pending");
    fake.message({ from: OWNER, chat: GROUP, chatType: "group" }, "/pending");
    fake.message({ from: OWNER }, "/pending");
    await fake.handled();
    const replies = fake.sent("sendMessage");
    expect(replies).toHaveLength(5);
    expect(replies.every(({ chat_id }) => chat_id === String(OWNER))).toBe(true);
    const firstGrant = (await deliveryOf(first.id)).grantHash;
    const secondGrant = (await deliveryOf(second.id)).grantHash;
    expect(firstGrant).toBeTruthy();
    expect(secondGrant).toBeTruthy();
    expect(firstGrant).not.toBe(secondGrant);
    expect(await deliveryOf(held.id)).toMatchObject({ grantHash: null });
    expect(await deliveryOf(proof.id)).toMatchObject({ grantHash: null });
    expect(replies.some(({ text }) => String(text).includes("Status unknown"))).toBe(true);
    expect(replies.some(({ text }) => String(text).includes("Confirm it's you first."))).toBe(true);
    expect(
      await db
        .select()
        .from(channelDeliveries)
        .where(eq(channelDeliveries.actionId, unpublished.id)),
    ).toEqual([]);
    expect(
      replies.find(({ text }) => String(text).includes("Unpublished order"))?.reply_markup,
    ).toBeUndefined();
    expect(await queued("turn")).toEqual([]);
    const buyNvidia = replies.find(({ text }) => String(text).includes("Buy Nvidia"));
    const callback = /allow:[^"]+/u.exec(JSON.stringify(buyNvidia?.reply_markup))?.[0];
    expect(callback).toBeTruthy();
    expect(await press({ from: OWNER }, await messageIdOf(first.id), callback!)).toBe("Allowed.");
    expect(await statusOf(second.id)).toBe("awaiting_permission");
  });

  it("reads cash and the value of each take for /money without a local-only link", async () => {
    const position: Holding = {
      venue: "wallet",
      chain: "base",
      instrument: "native",
      symbol: "ETH",
      quantity: "2",
      decimals: 18,
      usdValue: "200.00",
      cash: false,
      priceId: null,
    };
    vi.mocked(portfolioNow).mockResolvedValue({
      totalUsd: "225.00",
      observedAt: new Date().toISOString(),
      unavailable: [],
      looking: [],
      assets: { usdValue: "200.00", holdings: [position] },
      cash: { usdValue: "25.00", holdings: [] },
      onTheWay: { usdValue: "0.00", moves: [] },
      holdings: [position],
    });
    await db.update(threads).set({ title: "ETH take" }).where(eq(threads.id, thread.id));
    const other = await insertThread({ title: "Other ETH take" });
    for (const threadId of [thread.id, other.id]) {
      const action = await waiting({ threadId, status: "done" });
      await db.insert(fills).values({
        actionId: action.id,
        threadId,
        chain: "base",
        instrument: "native",
        side: "buy",
        quantity: "1",
        usdValue: "100",
      });
    }
    fake.calls.length = 0;
    fake.message({ from: STRANGER }, "/money");
    fake.message({ from: OWNER }, "/money");
    await fake.handled();
    expect(fake.sent("sendMessage")).toMatchObject([
      {
        chat_id: String(OWNER),
        text: "<b>Money</b>\n\n<blockquote>Total: $225\nCash: $25\nETH take: $100\nOther ETH take: $100</blockquote>",
      },
    ]);
    expect(fake.sent("sendMessage")[0]?.reply_markup).toBeUndefined();
    expect(portfolioNow).toHaveBeenCalledTimes(1);
    expect(await queued("turn")).toEqual([]);

    const saved = { WEB_ORIGIN: env.WEB_ORIGIN, TAILSCALE_OWNER: env.TAILSCALE_OWNER };
    try {
      Object.assign(env, {
        WEB_ORIGIN: "https://evo-t1.example.ts.net",
        TAILSCALE_OWNER: "owner@example.com",
      });
      fake.message({ from: OWNER }, "/money");
      await fake.handled();
      expect(fake.sent("sendMessage").at(-1)?.reply_markup).toEqual({
        inline_keyboard: [[{ text: "Open Money", url: "https://evo-t1.example.ts.net/app" }]],
      });
    } finally {
      Object.assign(env, saved);
    }
  });
});

describe("the owner's messages", () => {
  it("edits a single long-turn status into the answer", async () => {
    const incoming = fake.message({ from: OWNER }, "Check Hyperliquid");
    await fake.handled();
    const { id: threadId } = await mainChat(db);
    const [message] = await db.select().from(messages).where(eq(messages.threadId, threadId));
    const turnId = message!.id;
    const replyTo = `123456:${OWNER}:${incoming}`;
    const activity = (toolName: string) =>
      publishThreadEvent(threadId, {
        kind: "chunks",
        turnId,
        chunks: [{ type: "tool-input-available", toolCallId: toolName, toolName, input: {} }],
      });
    fake.calls.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      activity("hyperliquid_markets");
      vi.setSystemTime(Date.now() + 9_000);
      await expect
        .poll(() => fake.sent("sendMessage")[0]?.text, { timeout: 6_000 })
        .toBe("Checking Hyperliquid…");
      activity("get_portfolio");
      await expect
        .poll(() => fake.sent("editMessageText")[0]?.text, { timeout: 6_000 })
        .toBe("Checking your balances…");
      publishThreadEvent(threadId, { kind: "turn-end", turnId });
      const [answer] = await db
        .insert(messages)
        .values({
          threadId,
          role: "assistant",
          parts: [{ type: "text", text: "The final answer." }],
        })
        .returning({ id: messages.id });
      await deliver({ channel: "telegram", threadId, replyTo, messageId: answer!.id });
    } finally {
      vi.useRealTimers();
    }
    expect(fake.sent("sendMessage")).toHaveLength(1);
    expect(fake.sent("sendMessage")[0]?.reply_parameters).toMatchObject({ message_id: incoming });
    const [update, completed] = fake.sent("editMessageText");
    expect(completed).toMatchObject({ message_id: update?.message_id, text: "The final answer." });
  }, 15_000);

  it("join their main chat, or the thread of the card they reply to", async () => {
    const incoming = fake.message({ from: OWNER }, "What do I hold?");
    await fake.handled();
    const main = await mainChat(db);
    const [first] = await db.select().from(messages).where(eq(messages.threadId, main.id));
    expect(first).toMatchObject({ role: "user", metadata: { channel: "telegram" } });
    expect(first?.metadata.channelRef).toBe(`123456:${OWNER}:${incoming}`);
    expect(fake.sent("setMessageReaction")).toMatchObject([
      { chat_id: String(OWNER), message_id: incoming },
    ]);
    await expect.poll(() => fake.sent("sendChatAction")).toHaveLength(1);
    // The next one, replying to nothing, joins the same chat: one memory.
    fake.message({ from: OWNER }, "And in cash?");
    await fake.handled();
    expect(await db.select().from(messages).where(eq(messages.threadId, main.id))).toHaveLength(2);

    const specialist = await insertThread();
    const action = await waiting({ threadId: specialist.id });
    await answer(specialist.id, [
      {
        type: "data-cards",
        data: { cards: [{ kind: "action", actionReference: action.id, title: "Buy" }] },
      },
    ]);
    fake.message({ from: OWNER }, "Make it $20 instead", await messageIdOf(action.id));
    await fake.handled();
    const replies = await db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, specialist.id), eq(messages.role, "user")));
    expect(replies.map((row) => row.parts)).toEqual([
      [{ type: "text", text: "Make it $20 instead" }],
    ]);
  });

  it("reach the agent, and are answered, after the owner moves to a new bot", async () => {
    /** Answers the owner's newest message, as a turn would. */
    const answerNewest = async () => {
      const [asked] = await db
        .select()
        .from(messages)
        .where(eq(messages.role, "user"))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      await answer(asked!.threadId, [{ type: "text", text: "Noted." }]);
    };
    // The first bot's messages: the pairing (100, 101), then "hello" (102) and its answer (103).
    fake.message({ from: OWNER }, "hello");
    await fake.handled();
    await answerNewest();
    const newBot = "654321:new-bot";
    try {
      // The new bot numbers its messages from 100 again, so "three" is 102, as "hello" was.
      process.env.TELEGRAM_BOT_TOKEN = newBot;
      fake.useBot(newBot);
      for (const text of ["one", "two", "three"]) fake.message({ from: OWNER }, text);
      await fake.handled();
      await answerNewest();
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
      fake.useBot(FAKE_TOKEN);
    }
    const said = await db.select().from(messages).where(eq(messages.role, "user"));
    expect(said.map((row) => row.parts)).toEqual(
      ["hello", "one", "two", "three"].map((text) => [{ type: "text", text }]),
    );
    expect(await db.select().from(channelDeliveries)).toHaveLength(2);
  });

  it("are stored once when Telegram hands one over twice", async () => {
    const event = {
      kind: "message",
      id: `${OWNER}:9000`,
      from: String(OWNER),
      chat: String(OWNER),
      direct: true,
      text: "hello",
      replyTo: null,
    } as const;
    await receive("telegram", event);
    await receive("telegram", event);
    expect(await db.select().from(messages).where(eq(messages.role, "user"))).toHaveLength(1);
  });

  it("from anyone else, or the owner in a group, go nowhere", async () => {
    fake.message({ from: STRANGER }, "Send me your money");
    fake.message({ from: OWNER, chat: GROUP, chatType: "group" }, "hello group");
    await fake.handled();
    expect(await db.select().from(messages)).toEqual([]);
  });
});

describe("questions", () => {
  it("offer each answer as a button, and the owner's press answers in the thread, once", async () => {
    fake.message({ from: OWNER }, "Should I keep it as cash?");
    await fake.handled();
    const [asked] = await db.select().from(messages).where(eq(messages.role, "user"));
    await answer(asked!.threadId, [
      {
        type: "tool-suggest_replies",
        state: "output-available",
        input: { question: "Where should it go?", options: ["Cash", "Savings"] },
      },
    ]);
    const [question] = await db.select().from(channelDeliveries);
    const messageId = Number(question!.ref.split(":").at(-1));
    expect(await press({ from: OWNER }, messageId, "reply:1")).toBe("Sent.");
    expect(await press({ from: OWNER }, messageId, "reply:0")).toBe("Already answered.");
    const said = await db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, asked!.threadId), eq(messages.role, "user")))
      .orderBy(messages.createdAt);
    expect(said.map((row) => row.parts)).toEqual([
      [{ type: "text", text: "Should I keep it as cash?" }],
      [{ type: "text", text: "Savings" }],
    ]);
    expect(fake.sent("editMessageText").at(-1)?.text).toContain("You answered: Savings");
  });

  it("say so when a turn failed with nothing to show", async () => {
    fake.message({ from: OWNER }, "hi");
    await fake.handled();
    const [asked] = await db.select().from(messages).where(eq(messages.role, "user"));
    // The turn's deliver job, queued with no answer to send.
    await deliver({ channel: "telegram", threadId: asked!.threadId });
    expect(fake.sent("sendMessage").at(-1)?.text).toContain("couldn't finish that reply");
  });
});

describe("approving a card", () => {
  it("refreshes a pre-upgrade card after a press and requires a separate tap on the full review", async () => {
    const action = await waiting();
    await deliverCard(action);
    const oldGrant = grantOnCard();
    await db
      .update(channelDeliveries)
      .set({ shown: "old-layout-digest" })
      .where(eq(channelDeliveries.actionId, action.id));
    const id = await messageIdOf(action.id);
    expect(await press({ from: OWNER }, id, `allow:${oldGrant}`)).toBe(
      "Review the updated card first.",
    );
    expect(await statusOf(action.id)).toBe("awaiting_permission");
    expect(signer.calls).toBe(0);

    const refreshed = JSON.stringify(fake.sent("editMessageText").at(-1)?.reply_markup);
    const grant = /allow:([^"]+)/u.exec(refreshed)?.[1];
    expect(grant).toBeTruthy();
    expect(grant).not.toBe(oldGrant);
    expect(await press({ from: OWNER }, id, `allow:${grant}`)).toBe("Allowed.");
    expect(signer.calls).toBe(1);
  });

  it("runs it on the owner's press in their direct chat, once, and shows it allowed here", async () => {
    const action = await waiting();
    await deliverCard(action);
    const grant = grantOnCard();
    const messageId = await messageIdOf(action.id);

    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toBe("Allowed.");
    expect(signer.calls).toBe(1);
    expect(await statusOf(action.id)).toBe("done");
    // The second press of the same button finds its grant spent.
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/expired/u);
    expect(signer.calls).toBe(1);

    await syncCards();
    const edits = fake.sent("editMessageText");
    expect(edits.at(-1)).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: "View transaction", url: expect.stringContaining("/tx/0xabc") }],
        ],
      },
    });
    expect(String(edits.at(-1)!.text)).toMatch(/Done\n\nAllowed here\.$/u);
  });

  it("applies an ask on the owner's press, through the same path, with nothing to sign", async () => {
    const ask = await waitingAsk();
    await deliverCard(ask);
    const grant = grantOnCard();
    expect(await press({ from: OWNER }, await messageIdOf(ask.id), `allow:${grant}`)).toBe(
      "Allowed.",
    );
    expect(await statusOf(ask.id)).toBe("done");
    expect(await actModes()).toContain("within_limits");
    expect(signer.calls).toBe(0);
    await syncCards();
    expect(String(fake.sent("editMessageText").at(-1)!.text)).toMatch(
      /Updated\n\nAllowed here\.$/u,
    );
  });

  it("keeps a routine of the largest size one message, allowed in the app, and shows it saved", async () => {
    rmSync(routinesDir(), { recursive: true, force: true });
    const body = `${"Read the rate. ".repeat(266)}FINAL STEP.`.slice(-4_000);
    const description = "d".repeat(1_024);
    expect(routineBodySchema.parse(body)).toBe(body);
    expect(routineDescriptionSchema.parse(description)).toBe(description);
    const ask = await waiting({
      tool: "save_routine",
      venue: null,
      amountUsd: "0",
      summary: "Save a routine: check-rates",
      input: { name: "check-rates", description, body, replaces: null },
      lines: [
        { label: "When to use it", value: description },
        { label: "What it says", value: body },
      ],
    });
    await deliverCard(ask);
    const card = fake.sent("sendMessage").at(-1)!;
    expect(String(card.text)).toMatch(/<b>Save a routine: check-rates<\/b>\nWaiting on you\n/u);
    expect(JSON.stringify(fake.sent("sendMessage"))).not.toContain("allow:");
    expect(await deliveryOf(ask.id)).toMatchObject({ grantHash: null });

    expect((await allowAction(ask.id)).kind).toBe("allowed");
    await syncCards();
    const edit = fake.sent("editMessageText").at(-1)!;
    expect(edit.message_id).toBe(await messageIdOf(ask.id));
    expect(String(edit.text)).toContain(
      "<b>Save a routine: check-rates</b>\nSaved\n\nAllowed in the app.",
    );
  });

  // A secret is typed into a private field, which only the web app draws: no tap here may stand
  // in for it, and the card links to itself there. A card that only switches an app back on is
  // tapped here.
  it("shows a card asking for a secret with no buttons, linking to it in the app", async () => {
    const ask = await waiting({
      tool: "request_secret",
      venue: null,
      amountUsd: "0",
      summary: "Elfa API key",
      input: { field: "keys:elfa", app: "elfa", why: "I could show you the week's stories." },
      lines: [{ label: "Auni says", value: "I could show you the week's stories." }],
    });
    await deliverCard(ask);
    const sent = fake.sent("sendMessage").at(-1)!;
    expect(String(sent.text)).toContain("Saved only on this computer. Never paste it in chat.");
    expect(String(sent.text)).toContain("to enter it in a private field.");
    expect(sent.reply_markup).toBeUndefined();
    expect(JSON.stringify(fake.sent("sendMessage"))).not.toContain("allow:");
    expect(await deliveryOf(ask.id)).toMatchObject({ grantHash: null });

    const other = await waiting({
      tool: "connect_app",
      venue: null,
      amountUsd: "0",
      summary: "Turn Elfa on",
      input: { app: "elfa", why: "I could show you the week's stories." },
      lines: [],
    });
    await deliverCard(other);
    expect(JSON.stringify(fake.sent("sendMessage").at(-1))).toContain("allow:");
  });

  it("declines it on the owner's press, and tells the thread", async () => {
    const action = await waiting();
    await deliverCard(action);
    const grant = grantOnCard();
    expect(await press({ from: OWNER }, await messageIdOf(action.id), `decline:${grant}`)).toBe(
      "Declined.",
    );
    expect(await statusOf(action.id)).toBe("cancelled");
    expect(signer.calls).toBe(0);
    const wakes = (await queued("turn")).filter(({ data }) => "reason" in data);
    expect(wakes).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: thread.id,
          reason: expect.stringContaining(`declined action ${action.id}`),
        }),
      }),
    ]);
  });

  it("stops keeping a card in step once the owner deletes its message", async () => {
    const action = await waiting();
    await deliverCard(action);
    fake.deleteMessage(await messageIdOf(action.id));
    expect((await allowAction(action.id)).kind).toBe("allowed");
    await runQueued();
    await syncCards();
    expect(await deliveryOf(action.id)).toMatchObject({ open: false, grantHash: null });
    const edits = fake.sent("editMessageText").length;
    await syncCards();
    expect(fake.sent("editMessageText")).toHaveLength(edits);
  });

  it("lets one decision win across channels, and says where it was made", async () => {
    const action = await waiting();
    await deliverCard(action);
    const grant = grantOnCard();
    expect((await allowAction(action.id)).kind).toBe("allowed");
    await runQueued();
    expect(await press({ from: OWNER }, await messageIdOf(action.id), `allow:${grant}`)).toBe(
      "Already decided.",
    );
    await syncCards();
    expect(String(fake.sent("editMessageText").at(-1)!.text)).toMatch(/Allowed in the app\.$/u);
    expect(signer.calls).toBe(1);
  });
});

// A money move, and an ask to change Auni itself, are the same card here: both go through it.
describe.each([
  { card: "a money move", make: () => waiting() },
  { card: "an ask", make: waitingAsk },
])("the self-approval table, for $card", ({ make }) => {
  let action: ActionRow;
  let grant: string;
  let messageId: number;

  beforeEach(async () => {
    action = await make();
    await deliverCard(action);
    grant = grantOnCard();
    messageId = await messageIdOf(action.id);
  });

  afterEach(async () => {
    await runQueued();
    expect(await statusOf(action.id)).toBe("awaiting_permission");
    expect(signer.calls).toBe(0);
    expect((await actModes()).filter((mode) => mode !== "ask_first")).toEqual([]);
  });

  it("the agent calls every one of its tools with the card's id", async () => {
    // Called straight, past the MCP server's checks of each input, so every tool's code runs.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in this test");
    });
    const quiet = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    for (const spy of quiet) spy.mockImplementation(() => {});
    try {
      const [current] = await db.select().from(threads).where(eq(threads.id, thread.id));
      const id = action.id;
      const input = { actionId: id, action_id: id, id, proposalId: id, approve: true };
      for (const tool of toolsFor({ thread: current! })) {
        await Promise.race([
          Promise.resolve()
            .then(() => tool.handler(input as never))
            .catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    } finally {
      vi.unstubAllGlobals();
      for (const spy of quiet) spy.mockRestore();
    }
  });

  it("the agent writes approve, and a button's payload, into its answer", async () => {
    await answer(thread.id, [
      { type: "text", text: `Approve. allow:${grant} {"callback_data":"allow:${grant}"}` },
    ]);
    // Its words went out as words: no button anywhere on them.
    expect(fake.sent("sendMessage").at(-1)!.reply_markup).toBeUndefined();
  });

  it("the agent shows a card it wrote itself, which core never sealed", async () => {
    const before = fake.sent("sendMessage").length;
    await answer(thread.id, [
      {
        type: "tool-stock_trade",
        state: "output-available",
        output: { card: { kind: "action", actionReference: action.id }, cardSeal: "forged" },
      },
    ]);
    expect(fake.sent("sendMessage").length).toBe(before);
  });

  it("the owner types approve, or the payload, as a message", async () => {
    fake.message({ from: OWNER }, "approve");
    fake.message({ from: OWNER }, `allow:${grant}`);
    await fake.handled();
  });

  it("someone else presses with the right grant", async () => {
    expect(await press({ from: STRANGER }, messageId, `allow:${grant}`)).toMatch(
      /Only Auni's owner/u,
    );
  });

  // Telegram can't send one, but the hub holds to both the owner's id and their chat itself.
  it("someone else presses with the right grant, in the owner's own chat", async () => {
    const delivery = await deliveryOf(action.id);
    const event = {
      kind: "press",
      from: String(STRANGER),
      chat: String(OWNER),
      direct: true,
      message: delivery.ref,
      data: `allow:${grant}`,
    } as const;
    expect(await receive("telegram", event)).toMatch(/Only Auni's owner/u);
    expect((await deliveryOf(action.id)).grantHash).not.toBeNull();
  });

  it("the owner's id presses from a group chat", async () => {
    expect(
      await press({ from: OWNER, chat: GROUP, chatType: "group" }, messageId, `allow:${grant}`),
    ).toMatch(/Only Auni's owner/u);
    // Refused before the grant was touched, so the owner's own press would still work.
    expect((await deliveryOf(action.id)).grantHash).not.toBeNull();
  });

  it("the grant is pressed on another message", async () => {
    expect(await press({ from: OWNER }, messageId + 1, `allow:${grant}`)).toMatch(/expired/u);
  });

  it("a made-up grant is pressed", async () => {
    expect(await press({ from: OWNER }, messageId, "allow:AAAAAAAAAAAAAAAAAAAAAA")).toMatch(
      /expired/u,
    );
    expect(await press({ from: OWNER }, messageId, "approve")).toBe("That button isn't active.");
  });

  it("a grant past its day is pressed", async () => {
    await db
      .update(channelDeliveries)
      .set({ grantExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(channelDeliveries.actionId, action.id));
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/expired/u);
  });

  it("the card changed after it was sent (a re-quote), and the grant is pressed, then replayed", async () => {
    const shown = action.lines;
    await db
      .update(actions)
      .set({ lines: [{ label: "You give", value: "500 USDC" }], amountUsd: "500" })
      .where(eq(actions.id, action.id));
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/changed/u);
    // Back as it was shown: the grant was spent by that press all the same.
    await db
      .update(actions)
      .set({ lines: shown, amountUsd: "10" })
      .where(eq(actions.id, action.id));
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/expired/u);
  });

  // A grant is bound to the card as the owner read it: its words, as well as what it would do.
  it.each([
    ["its sentence", { summary: "Buy about $10 of something else" }],
    ["a word of its face", { card: { ...FACE, title: "Buy something else" } }],
  ])("the card's words changed after it was sent (%s), and the grant is pressed", async (_, to) => {
    await db.update(actions).set(to).where(eq(actions.id, action.id));
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/changed/u);
    expect(await statusOf(action.id)).toBe("awaiting_permission");
  });

  it("what the card would do changed after it was sent, and the grant is pressed", async () => {
    await db
      .update(actions)
      .set({ input: { ...action.input, budget_usd: "9000.00", usd: "9000" } })
      .where(eq(actions.id, action.id));
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/changed/u);
  });

  it("a card that takes the owner's proof is pressed with a grant it was never drawn with", async () => {
    // A browser paired this minute would allow it on a tap; a press here is no such browser.
    await db.insert(ownerSessions).values({
      tokenHash: "a-browser-paired-this-minute",
      kind: "session",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Money leaving to an address it never went to: the proof rung (money/step-up.ts).
    const leaving = await waiting({
      tool: "withdraw_usdc",
      details: { leavesTo: "0x5b7a3f0e2c9d41a8b6e0f7c2d9a4b1e3f6c8d0a2" },
    });
    fake.calls.length = 0;
    await deliverCard(leaving);
    const sent = fake.sent("sendMessage").at(-1)!;
    // No button decides it; the app does, where Auni can check it's the owner.
    expect(JSON.stringify(sent.reply_markup ?? "")).not.toContain("allow:");
    const leavingId = await messageIdOf(leaving.id);
    // Even a grant put on it by hand only reaches the web app's own path, which takes no proof
    // from a channel.
    await db
      .update(channelDeliveries)
      .set({
        grantHash: hashOf("forged-grant"),
        grantExpiresAt: new Date(Date.now() + 60_000),
        cardDigest: legsDigest([leaving]),
      })
      .where(eq(channelDeliveries.actionId, leaving.id));
    expect(await press({ from: OWNER }, leavingId, "allow:forged-grant")).toBe(
      "Confirm it's you in Auni to allow this.",
    );
    expect(await statusOf(leaving.id)).toBe("awaiting_permission");
  });
});

describe("approving a plan", () => {
  const PLAN = "00000000-0000-4000-8000-0000000000a1";
  const planLegs = (second: Partial<ActionRow> = {}) =>
    Promise.all([
      waiting({ proposalId: PLAN }),
      waiting({ proposalId: PLAN, summary: "Then the second", ...second }),
    ]);
  const planDelivery = async () =>
    (await db.select().from(channelDeliveries).where(eq(channelDeliveries.proposalId, PLAN)))[0]!;
  const planMessage = async () => Number((await planDelivery()).ref.split(":").at(-1));

  it("runs every leg on the owner's press, once", async () => {
    const legs = await planLegs();
    await deliverPlan(PLAN);
    expect(await press({ from: OWNER }, await planMessage(), `allow:${grantOnCard()}`)).toBe(
      "Allowed.",
    );
    expect(await Promise.all(legs.map(({ id }) => statusOf(id)))).toEqual(["done", "done"]);
  });

  // The grant rides in a button a channel can deliver twice; a press that decided nothing spends
  // it all the same, and the card is redrawn with a fresh one for the owner's next tap.
  it("takes a grant once, even when its press decided nothing", async () => {
    const legs = await planLegs();
    await deliverPlan(PLAN);
    const grant = grantOnCard();
    const messageId = await planMessage();
    funding.needUsd = "5.00";
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/Add \$5/u);
    funding.needUsd = null;
    expect(await press({ from: OWNER }, messageId, `allow:${grant}`)).toMatch(/expired/u);
    expect(await Promise.all(legs.map(({ id }) => statusOf(id)))).toEqual([
      "awaiting_permission",
      "awaiting_permission",
    ]);
    await syncCards();
    const fresh = grantOnCard();
    expect(fresh).not.toBe(grant);
    expect(await press({ from: OWNER }, messageId, `allow:${fresh}`)).toBe("Allowed.");
  });

  it("leaves a plan whose leg takes the owner's proof to the app, even pressed with a grant put on it by hand", async () => {
    // Money leaving to an address it never went to: the proof rung (money/step-up.ts).
    const legs = await planLegs({
      tool: "withdraw_usdc",
      details: { leavesTo: "0x5b7a3f0e2c9d41a8b6e0f7c2d9a4b1e3f6c8d0a2" },
    });
    await deliverPlan(PLAN);
    expect(JSON.stringify(fake.sent("sendMessage").at(-1)!.reply_markup ?? "")).not.toContain(
      "allow:",
    );
    await db
      .update(channelDeliveries)
      .set({
        grantHash: hashOf("forged-grant"),
        grantExpiresAt: new Date(Date.now() + 60_000),
        cardDigest: legsDigest(legs),
      })
      .where(eq(channelDeliveries.proposalId, PLAN));
    expect(await press({ from: OWNER }, await planMessage(), "allow:forged-grant")).toMatch(
      /Confirm it's you/u,
    );
    expect(await Promise.all(legs.map(({ id }) => statusOf(id)))).toEqual([
      "awaiting_permission",
      "awaiting_permission",
    ]);
    expect(signer.calls).toBe(0);
  });
});
