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
import { FAKE_TOKEN, FakeBotApi } from "./fake-bot-api.ts";
import { insertAction, insertThread, wipe } from "../../test/db.ts";
import { queued } from "../../test/jobs.ts";
import { homeChannel } from "../../channels/home.ts";
import { deliver } from "../../channels/hub.ts";

// Telegram as the home channel: what Auni says unasked reaches the owner's home channel: the one they chose, or else the one
// they last talked to it from, and only while it is set up and paired.

const replay = vi.hoisted(() => ({ events: [] as unknown[] }));
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
  walletAddresses: async () => null,
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
    await sendMessage(chat, { id, text: "How am I doing?", channel: "telegram" });
    replay.events = answers("Up 3% today.");
    await runConversationTurn({
      threadId: chat.id,
      turnId: id,
      trigger: { kind: "message", messageId: id },
    });
    expect((await queued("deliver")).map(({ data }) => data.channel)).toEqual(["telegram"]);
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
});
