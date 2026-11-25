import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { conversationTools } from "../../conversation/tools.ts";
import { sendMessage } from "../../conversation/send.ts";
import { runConversationTurn } from "../../conversation/turn.ts";
import { db } from "../../db/client.ts";
import {
  actions,
  channelDeliveries,
  channelLinks,
  jobs,
  messages,
  owner as ownerSettings,
  threads,
  type OwnerRow,
  type ThreadRow,
} from "../../db/schema.ts";
import type { BrainEvent } from "../contract.ts";
import { deliverKind } from "../../jobs/kinds.ts";
import { FAKE_TOKEN, FakeBotApi } from "./fake-bot-api.ts";
import { insertAction, insertThread, wipe } from "../../test/db.ts";
import { queued } from "../../test/jobs.ts";
import { syncCards } from "../../channels/cards.ts";
import { homeChannel } from "../../channels/home.ts";
import { deliver } from "../../channels/hub.ts";

// Telegram as the home channel: what Auni says unasked reaches the owner's home channel: the one they chose, or else the one
// they last talked to it from, and only while it is set up and paired.

const replay = vi.hoisted(() => ({ events: [] as unknown[] }));
const address = "0x0123456789abcdef0123456789abcdef01234567";
const wallet = vi.hoisted(() => ({ evm: null as string | null, solana: null }));
vi.mock("../../agent/brain.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/brain.ts")>()),
  pickBrain: async () => ({
    about: { id: "fake", name: "Fake" },
    login: "test",
    brain: {
      async *run() {
        yield* replay.events as BrainEvent[];
      },
    },
  }),
  brainBox: async () => ({}),
}));
vi.mock("../../agent/prompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/prompt.ts")>()),
  systemPrompt: async () => "You are Auni.",
}));
vi.mock("../../money/wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../money/wallets.ts")>()),
  walletAddresses: async () => ({ ...wallet }),
}));

const OWNER = "4242";
const fake = new FakeBotApi();
let chat: ThreadRow;

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
  await wipe(threads, messages, actions, channelDeliveries, jobs);
  fake.calls.length = 0;
  wallet.evm = address;
  fake.useBot(FAKE_TOKEN);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  chat = await insertThread();
});

const paired = () =>
  db.insert(channelLinks).values({
    channel: "telegram",
    owner: OWNER,
    chat: OWNER,
    pairedAt: new Date(),
  });

const home = () => homeChannel();
const setSettings = (fields: Partial<OwnerRow>) => db.update(ownerSettings).set(fields);

describe("homeChannel", () => {
  it("follows the last used, unless the owner picked one", async () => {
    await paired();
    expect(await home()).toBeNull();
    await sendMessage(chat, { id: crypto.randomUUID(), text: "hi", channel: "telegram" });
    expect(await home()).toBe("telegram");
    await sendMessage(chat, { id: crypto.randomUUID(), text: "back on the web" });
    expect(await home()).toBeNull();

    await setSettings({ homeChannel: "telegram" });
    expect(await home()).toBe("telegram");
    await setSettings({ homeChannel: "web", lastChannel: "telegram" });
    expect(await home()).toBeNull();
  });

  it("is the web app for a channel never paired, or no longer set up", async () => {
    await setSettings({ homeChannel: "telegram" });
    expect(await home()).toBeNull();
    await paired();
    expect(await home()).toBe("telegram");
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      expect(await home()).toBeNull();
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    }
  });

  it("is what the owner asks Auni for with set_notices", async () => {
    await paired();
    const [, setNotices] = conversationTools({ threadId: crypto.randomUUID() });
    const picked = await setNotices!.handler({ home: "telegram" });
    expect(picked.structuredContent).toMatchObject({
      home: "telegram",
      sends_to: "telegram",
      channels: [{ id: "telegram", name: "Telegram" }],
    });
    expect((await setNotices!.handler({ home: "web" })).structuredContent).toMatchObject({
      home: "web",
      sends_to: "web",
    });
    expect((await setNotices!.handler({ home: "carrier-pigeon" })).isError).toBe(true);
    await setNotices!.handler({ home: "last_used" });
    expect((await db.select().from(ownerSettings))[0]!.homeChannel).toBeNull();
  });
});

describe("a turn's answer", () => {
  const answers = (text: string): BrainEvent[] => [
    { type: "ready", model: "fake", login: "test" },
    { type: "text", id: "t1", delta: text },
    { type: "done" },
  ];
  const background = () =>
    runConversationTurn({
      threadId: chat.id,
      turnId: crypto.randomUUID(),
      trigger: { kind: "background", reason: "Your buy of $10 of Nvidia landed." },
    });

  it("said unasked is queued for the home channel with the answer it sends", async () => {
    await paired();
    await setSettings({ homeChannel: "telegram" });
    replay.events = answers("Your Nvidia buy landed.");
    await background();
    const [answer] = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(await queued("deliver")).toEqual([
      expect.objectContaining({
        data: { channel: "telegram", threadId: chat.id, messageId: answer!.id },
        lanes: ["channel:telegram"],
      }),
    ]);
  });

  it("goes nowhere but the web when it settles quietly, or home is the web", async () => {
    await paired();
    await setSettings({ homeChannel: "telegram" });
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "tool-call", id: "q", name: "settle_quietly", input: { reason: "Nothing new" } },
      { type: "tool-result", id: "q", output: "Settled quietly.", isError: false },
      { type: "done" },
    ];
    await background();
    await setSettings({ homeChannel: "web", lastChannel: "telegram" });
    replay.events = answers("Your Nvidia buy landed.");
    await background();
    expect(await db.select().from(messages)).toHaveLength(2);
    expect(await queued("deliver")).toEqual([]);
  });

  it("to the owner's message goes back to the channel it came from, not home", async () => {
    await paired();
    await setSettings({ homeChannel: "web" });
    const id = crypto.randomUUID();
    await sendMessage(chat, {
      id,
      text: "How am I doing?",
      channel: "telegram",
      channelRef: `123456:${OWNER}:55`,
    });
    replay.events = answers("Up 3% today.");
    await runConversationTurn({
      threadId: chat.id,
      turnId: id,
      trigger: { kind: "message", messageId: id },
    });
    const [queuedAnswer] = await queued("deliver");
    expect(queuedAnswer?.data).toMatchObject({
      channel: "telegram",
      replyTo: `123456:${OWNER}:55`,
    });
    await deliver(deliverKind.data.parse(queuedAnswer?.data));
    expect(fake.sent("sendMessage")[0]?.reply_parameters).toEqual({
      message_id: 55,
      allow_sending_without_reply: true,
    });
  });
});

describe("deliver", () => {
  it("sends the stored answer's words, and its card with a grant on Allow", async () => {
    await paired();
    const action = await insertAction({
      threadId: chat.id,
      status: "awaiting_permission",
      lines: [{ label: "You give", value: "10 USDC" }],
    });
    const [answer] = await db
      .insert(messages)
      .values({
        threadId: chat.id,
        role: "assistant",
        parts: [
          { type: "text", text: "Nvidia dipped under your level. Buy $10?" },
          {
            type: "data-cards",
            data: { cards: [{ kind: "action", actionReference: action.id, title: "Buy Nvidia" }] },
          },
        ],
      })
      .returning();
    await deliver({ channel: "telegram", threadId: chat.id, messageId: answer!.id });
    const sent = fake.sent("sendMessage");
    expect(sent[0]).toMatchObject({ chat_id: OWNER, text: expect.stringContaining("Nvidia") });
    expect(JSON.stringify(sent[1]!.reply_markup)).toContain("allow:");
    const [card] = await db
      .select()
      .from(channelDeliveries)
      .where(eq(channelDeliveries.actionId, action.id));
    expect(card).toMatchObject({ threadId: chat.id, open: true });
    expect(card!.grantHash).not.toBeNull();
  });

  it("sends nothing while the channel is unpaired", async () => {
    const [answer] = await db
      .insert(messages)
      .values({ threadId: chat.id, role: "assistant", parts: [{ type: "text", text: "Hi" }] })
      .returning();
    await deliver({ channel: "telegram", threadId: chat.id, messageId: answer!.id });
    expect(fake.sent("sendMessage")).toEqual([]);
  });

  it("clears the copy button on expiry and still edits in a deposit recorded late", async () => {
    await paired();
    const deposit = {
      kind: "deposit",
      id: "deposit-card",
      title: "Deposit USDC",
      network: "base",
      tokens: [],
      landed: null,
      updatedAt: new Date().toISOString(),
    };
    const parts = (card: object) => [{ type: "data-cards", data: { cards: [card] } }];
    const [answer] = await db
      .insert(messages)
      .values({
        threadId: chat.id,
        role: "assistant",
        parts: parts(deposit),
      })
      .returning();
    await deliver({ channel: "telegram", threadId: chat.id, messageId: answer!.id });
    expect(fake.sent("sendMessage")).toMatchObject([
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Copy Base wallet address", copy_text: { text: address } }]],
        },
      },
    ]);
    await syncCards();
    expect(fake.sent("editMessageText")).toEqual([]);
    wallet.evm = "0x2345678901234567890123456789012345678901";
    await syncCards();
    await syncCards();
    expect(fake.sent("editMessageText")).toMatchObject([
      {
        reply_markup: {
          inline_keyboard: [[{ copy_text: { text: wallet.evm } }]],
        },
      },
    ]);
    fake.calls.length = 0;
    await db
      .update(messages)
      .set({
        parts: parts({
          ...deposit,
          updatedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        }),
      })
      .where(eq(messages.id, answer!.id));
    await syncCards();
    await syncCards();
    expect(fake.sent("editMessageText")).toMatchObject([
      {
        text: expect.stringContaining("stopped watching"),
        reply_markup: { inline_keyboard: [] },
      },
    ]);
    fake.calls.length = 0;
    await db
      .update(messages)
      .set({
        parts: parts({
          ...deposit,
          landed: {
            usdValue: "250.00",
            network: "Base",
            moved: [{ amount: "250", symbol: "USDC", to: null }],
          },
        }),
      })
      .where(eq(messages.id, answer!.id));
    const [delivery] = await db.select().from(channelDeliveries);
    await syncCards();
    await syncCards();
    expect(fake.sent("editMessageText")).toMatchObject([
      {
        message_id: Number(delivery!.ref.split(":").at(-1)),
        text: "<b>$250 arrived</b>\n<blockquote>Base\n250 USDC</blockquote>",
        reply_markup: { inline_keyboard: [] },
      },
    ]);
    expect((await db.select().from(channelDeliveries))[0]?.open).toBe(false);
  });
});
