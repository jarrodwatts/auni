import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ChannelEvent } from "../contract.ts";
import { BotApiError, botApi } from "./bot-api.ts";
import { telegramChannel } from "./channel.ts";
import { FAKE_TOKEN, FakeBotApi } from "./fake-bot-api.ts";

const fake = new FakeBotApi();
let apiUrl = "";
beforeAll(async () => {
  apiUrl = await fake.start();
});
afterAll(() => fake.stop());
afterEach(() => {
  fake.calls.length = 0;
});

const channel = telegramChannel({ token: () => FAKE_TOKEN, apiUrl: () => apiUrl });

/** Listens until every queued update is handled, answering each press with `answer`. */
async function listen(answer?: string): Promise<ChannelEvent[]> {
  const seen: ChannelEvent[] = [];
  const stop = new AbortController();
  const listening = channel.listen(async (event) => {
    seen.push(event);
    return answer;
  }, stop.signal);
  await fake.handled();
  stop.abort();
  await listening;
  return seen;
}

describe("the Telegram channel", () => {
  it("is off without a token", () => {
    expect(telegramChannel({ token: () => undefined, apiUrl: () => apiUrl }).configured()).toBe(
      false,
    );
    expect(channel.configured()).toBe(true);
  });

  it("hands the hub who wrote, in which chat, and what it replies to", async () => {
    fake.message({ from: 7 }, "hello", 55);
    fake.message({ from: 7, chat: -100, chatType: "group" }, "in a group");
    expect(await listen()).toEqual([
      {
        kind: "message",
        id: "123456:7:100",
        from: "7",
        chat: "7",
        direct: true,
        text: "hello",
        replyTo: "123456:7:55",
      },
      expect.objectContaining({ from: "7", chat: "-100", direct: false, text: "in a group" }),
    ]);
  });

  it("hands Telegram's own /start and /help on as a hello, with the code a link carried", async () => {
    for (const text of ["/start abc123", "/start", "/help", "/start@auni_test_bot", "/starting"])
      fake.message({ from: 7 }, text);
    const sender = { from: "7", chat: "7", direct: true };
    expect(await listen()).toEqual([
      { kind: "hello", ...sender, code: "abc123" },
      { kind: "hello", ...sender, code: null },
      { kind: "hello", ...sender, code: null },
      { kind: "hello", ...sender, code: null },
      expect.objectContaining({ kind: "message", text: "/starting" }),
    ]);
  });

  it("hands on a press with the message it was under, and answers it with the hub's words", async () => {
    const press = fake.press({ from: 7 }, 120, "allow:abc");
    expect(await listen("Allowed.")).toEqual([
      {
        kind: "press",
        from: "7",
        chat: "7",
        direct: true,
        message: "123456:7:120",
        data: "allow:abc",
        answer: expect.any(Function),
      },
    ]);
    expect(fake.sent("answerCallbackQuery")).toEqual([
      { callback_query_id: press, text: "Allowed." },
    ]);
  });

  it("sends formatting and buttons, with directions in place of a local-only link", async () => {
    const refs = await channel.send("7", {
      text: "**Buy about $10 of Nvidia**",
      buttons: [
        [
          { label: "Allow", press: "allow:g" },
          { label: "Decline", press: "decline:g" },
        ],
        [{ label: "Open in the app", url: "http://localhost:3000/app/chat/t" }],
      ],
    });
    expect(refs).toEqual([expect.stringMatching(/^123456:7:\d+$/u)]);
    expect(fake.sent("sendMessage")).toEqual([
      expect.objectContaining({
        chat_id: "7",
        parse_mode: "HTML",
        text: "<b>Buy about $10 of Nvidia</b>\n\nOpen Auni on your computer.",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Allow", callback_data: "allow:g" },
              { text: "Decline", callback_data: "decline:g" },
            ],
          ],
        },
      }),
    ]);
  });

  it("registers a private command menu and hands commands to the hub", async () => {
    const fresh = telegramChannel({ token: () => FAKE_TOKEN, apiUrl: () => apiUrl });
    const stop = new AbortController();
    const seen: ChannelEvent[] = [];
    fake.message({ from: 7 }, "/pending@auni_test_bot");
    fake.message({ from: 7 }, "/money");
    const listening = fresh.listen(async (event) => {
      seen.push(event);
    }, stop.signal);
    await fake.handled();
    stop.abort();
    await listening;
    expect(fake.sent("setMyCommands")).toEqual([
      {
        scope: { type: "all_private_chats" },
        commands: expect.arrayContaining([
          expect.objectContaining({ command: "pending" }),
          expect.objectContaining({ command: "money" }),
        ]),
      },
    ]);
    expect(seen).toMatchObject([
      { kind: "hello", command: "pending" },
      { kind: "hello", command: "money" },
    ]);
  });

  it("acknowledges the press before doing the redraw", async () => {
    const callback = fake.press({ from: 7 }, 120, "allow:abc");
    const stop = new AbortController();
    const listening = channel.listen(async (event) => {
      if (event.kind === "press") {
        event.answer?.("Allowed.");
        await channel.edit(event.message, { text: "Sending" });
      }
      return "Allowed.";
    }, stop.signal);
    await fake.handled();
    stop.abort();
    await listening;
    const calls = fake.calls.filter(({ method }) =>
      ["answerCallbackQuery", "editMessageText"].includes(method),
    );
    expect(calls.map(({ method }) => method)).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(calls[0]?.params).toMatchObject({ callback_query_id: callback, text: "Allowed." });
  });

  it("sends an expandable block, a native copy button and a same-chat reply", async () => {
    await channel.send(
      "7",
      {
        text: "**Deposit on Base**",
        detail: "**Thinking**\nUse this address.",
        buttons: [[{ label: "Copy address", copy: "0x123" }]],
      },
      "123456:7:55",
    );
    expect(fake.sent("sendMessage")[0]).toMatchObject({
      text: "<blockquote expandable><b>Thinking</b>\n\nUse this address.</blockquote>\n\n<b>Deposit on Base</b>",
      reply_parameters: { message_id: 55, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: "Copy address", copy_text: { text: "0x123" } }]] },
    });
    await channel.send("7", { text: "another bot" }, "123457:7:55");
    await channel.send("7", { text: "another chat" }, "123456:8:55");
    expect(
      fake
        .sent("sendMessage")
        .slice(1)
        .every((message) => !message.reply_parameters),
    ).toBe(true);
  });

  it("folds long thinking once above the answer, with code, bullets and mobile table rows", async () => {
    await channel.send("7", {
      text: "**The answer**",
      detail:
        `**Thinking**\n\n${"Earlier research. ".repeat(1_000)}\n\n- Checked Base\n\n` +
        '```json\n{"fee": 0.03}\n```\n\n| Venue | Fee |\n| --- | --- |\n| Base | $0.03 |',
    });
    const sent = fake.sent("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(
      "<blockquote expandable><b>Thinking</b>\n\n• Checked Base\n\n<pre>{&quot;fee&quot;: 0.03}</pre>\n\nVenue: Base\nFee: $0.03\n\nFull thinking in Auni.</blockquote>\n\n<b>The answer</b>",
    );
  });

  it("sends plain text when Telegram can't parse the tags", async () => {
    fake.failNext("sendMessage", "Bad Request: can't parse entities: unclosed tag");
    await channel.send("7", { text: "**a [b** c](https://x.y)" });
    expect(fake.sent("sendMessage").map((params) => params.parse_mode ?? null)).toEqual([
      "HTML",
      null,
    ]);
  });

  it("splits a long answer, putting the buttons under its last message", async () => {
    const refs = await channel.send("7", {
      text: `${"a".repeat(3_000)}\n\n${"b".repeat(3_000)}`,
      buttons: [[{ label: "Yes", press: "reply:0" }]],
    });
    expect(refs).toHaveLength(2);
    expect(fake.sent("sendMessage").map((params) => Boolean(params.reply_markup))).toEqual([
      false,
      true,
    ]);
  });

  it("edits a message in place, and takes drawing it the same again as done", async () => {
    expect(await channel.edit("123456:7:120", { text: "Done" })).toBe(true);
    expect(fake.sent("editMessageText")).toEqual([
      expect.objectContaining({
        chat_id: "7",
        message_id: 120,
        reply_markup: { inline_keyboard: [] },
      }),
    ]);
    fake.failNext("editMessageText", "Bad Request: message is not modified");
    expect(await channel.edit("123456:7:120", { text: "Done" })).toBe(true);
  });

  it("says a message the owner deleted, or another bot sent, can't be edited", async () => {
    fake.deleteMessage(130);
    expect(await channel.edit("123456:7:130", { text: "Done" })).toBe(false);
    expect(await channel.edit("999:7:120", { text: "Done" })).toBe(false);
    expect(fake.sent("editMessageText")).toHaveLength(1);
  });

  it("gives up on a call Telegram never answers", async () => {
    fake.hangNext("sendMessage");
    const error = await botApi(
      apiUrl,
      FAKE_TOKEN,
      100,
    )("sendMessage", { chat_id: "7" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BotApiError);
    expect((error as BotApiError).description).toBe("Telegram didn't answer in time");
  });

  it("links the owner to the bot with the pairing code", async () => {
    expect(await channel.pairingHint("code123")).toBe("https://t.me/auni_test_bot?start=code123");
  });

  it("never puts its token in an error", async () => {
    const wrong = telegramChannel({ token: () => FAKE_TOKEN, apiUrl: () => "http://127.0.0.1:9" });
    const error = await wrong.send("7", { text: "hi" }).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
  });
});
