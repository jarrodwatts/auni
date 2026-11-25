import { setTimeout as sleep } from "node:timers/promises";

import type { Channel, ChannelEvent, ChannelMessage } from "../contract.ts";
import { BotApiError, botApi, type BotApi, type Message, type Update } from "./bot-api.ts";
import { chunks, detailHtml, MESSAGE_CHARS, toHtml, webLink } from "./format.ts";

// Long polling: getUpdates waits up to POLL_SECONDS for anything new and confirms what came before
// by its offset, so Auni needs no public URL and an update unconfirmed when it stopped comes again.

const POLL_SECONDS = 30;
const RETRY_MS = 5_000;

interface Options {
  readonly token: () => string | undefined;
  readonly apiUrl: () => string;
}

/** Telegram's reasons an edit can never land: the owner deleted the message, or it's too old. */
const GONE = ["message to edit not found", "message can't be edited"];

/**
 * The bot a token is for: the number before its colon. Telegram numbers each bot's messages from
 * the start, so a ref names its bot, and a new bot's messages never take an old one's refs.
 */
function botOf(token: string): string {
  const bot = /^(\d+):/u.exec(token)?.[1];
  if (!bot) throw new Error("The Telegram bot token isn't one BotFather gave (<bot id>:<secret>).");
  return bot;
}

/** A message, as the hub keeps it: "<bot id>:<chat id>:<message id>". */
type RefOf = (message: Pick<Message, "chat" | "message_id">) => string;

function parseRef(ref: string) {
  const [bot = "", chat = "", message = ""] = ref.split(":");
  return { bot, chat_id: chat, message_id: Number(message) };
}

export function telegramChannel(options: Options): Channel {
  const api: BotApi = (method, params, signal) => {
    const token = options.token();
    if (!token) throw new Error("Telegram isn't set up yet: it needs its Telegram bot token.");
    return botApi(options.apiUrl(), token)(method, params, signal);
  };
  const thisBot = () => botOf(options.token() ?? "");
  const refOf: RefOf = (message) => `${thisBot()}:${message.chat.id}:${message.message_id}`;
  let username: Promise<string> | undefined;
  let commandsFor: string | undefined;

  return {
    configured: () => Boolean(options.token()),

    async listen(receive, signal) {
      const bot = thisBot();
      if (commandsFor !== bot) {
        await api(
          "setMyCommands",
          { commands: COMMANDS, scope: { type: "all_private_chats" } },
          signal,
        )
          .then(() => {
            commandsFor = bot;
          })
          .catch(() => undefined);
      }
      let offset = 0;
      while (!signal.aborted) {
        let updates: Update[];
        try {
          updates = await api<Update[]>(
            "getUpdates",
            { offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"] },
            signal,
          );
        } catch (error) {
          if (signal.aborted) return;
          // A 409 is another Auni polling this bot; a 401 a token that's wrong.
          console.warn(error instanceof Error ? error.message : "Telegram's getUpdates failed");
          const wait =
            error instanceof BotApiError && error.retryAfter ? error.retryAfter * 1_000 : RETRY_MS;
          await sleep(wait, undefined, { signal }).catch(() => undefined);
          continue;
        }
        for (const update of updates) {
          // Confirmed by the next poll whatever happens, so one update that always fails can't
          // stop every one after it.
          offset = update.update_id + 1;
          try {
            await handle(api, refOf, update, receive);
          } catch (error) {
            console.error(`Telegram update ${update.update_id} couldn't be handled`, error);
          }
        }
      }
    },

    async send(chat, message, replyTo) {
      const { pieces, keyboard } = telegramForm(message);
      const reply = replyTo ? parseRef(replyTo) : null;
      const refs: string[] = [];
      for (const [index, piece] of pieces.entries()) {
        const sent = await withPlainFallback(piece, (form) =>
          api<Message>("sendMessage", {
            chat_id: chat,
            ...form,
            link_preview_options: { is_disabled: true },
            ...(index === 0 &&
            reply?.bot === thisBot() &&
            reply.chat_id === chat &&
            reply.message_id > 0
              ? {
                  reply_parameters: {
                    message_id: reply.message_id,
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
            ...(index === pieces.length - 1 && keyboard ? { reply_markup: keyboard } : {}),
          }),
        );
        refs.push(refOf(sent));
      }
      return refs;
    },

    async edit(ref, message) {
      const { bot, ...at } = parseRef(ref);
      // Sent by a bot this token isn't for, so this one can't reach it.
      if (bot !== thisBot()) return false;
      const { pieces, keyboard } = telegramForm(message);
      const [piece] = pieces;
      if (pieces.length !== 1 || !piece)
        throw new Error("The Telegram edit must fit in one message.");
      try {
        await withPlainFallback(piece, (form) =>
          api("editMessageText", {
            ...at,
            ...form,
            link_preview_options: { is_disabled: true },
            reply_markup: keyboard ?? { inline_keyboard: [] },
          }),
        );
      } catch (error) {
        if (!(error instanceof BotApiError)) throw error;
        // Drawn the same again: it shows this already.
        if (error.description.includes("message is not modified")) return true;
        if (GONE.some((reason) => error.description.includes(reason))) return false;
        throw error;
      }
      return true;
    },

    async typing(chat) {
      await api("sendChatAction", { chat_id: chat, action: "typing" });
    },

    async acknowledge(ref) {
      const { bot, ...at } = parseRef(ref);
      if (bot !== thisBot()) return;
      await api("setMessageReaction", { ...at, reaction: [{ type: "emoji", emoji: "👀" }] });
    },

    async pairingHint(code) {
      username ??= api<{ username: string }>("getMe", {}).then((me) => me.username);
      const name = await username.catch((error: unknown) => {
        username = undefined;
        throw error;
      });
      return `https://t.me/${name}?start=${code}`;
    },
  };
}

/**
 * Telegram's own commands: /start, which its Start button and a t.me link send (the link's
 * payload after it), and /help. "@<bot>" may follow either, as Telegram's command menu adds it.
 */
const COMMAND = /^\/(start|help|pending|portfolio)(?:@\w+)?(?:\s+(.*))?$/su;
const COMMANDS = [
  { command: "pending", description: "See what needs your tap" },
  { command: "portfolio", description: "Open your portfolio" },
  { command: "help", description: "How to talk to Auni here" },
  { command: "start", description: "Open your chat with Auni" },
];

/** One update as the hub reads it; a press is answered with what the hub said. */
async function handle(
  api: BotApi,
  refOf: RefOf,
  update: Update,
  receive: (event: ChannelEvent) => Promise<string | void>,
): Promise<void> {
  const press = update.callback_query;
  if (press) {
    let answered: Promise<unknown> | undefined;
    const answer = (text?: string | void) => {
      answered ??= api("answerCallbackQuery", {
        callback_query_id: press.id,
        ...(text ? { text } : {}),
      }).catch(() => undefined);
    };
    try {
      if (press.message && press.data && !press.from.is_bot)
        answer(
          await receive({
            kind: "press",
            from: String(press.from.id),
            chat: String(press.message.chat.id),
            direct: press.message.chat.type === "private",
            message: refOf(press.message),
            data: press.data,
            answer,
          }),
        );
    } finally {
      answer();
      await answered;
    }
    return;
  }
  const message = update.message;
  const text = message?.text ?? message?.caption;
  if (!message?.from || message.from.is_bot || !text) return;
  const sender = {
    from: String(message.from.id),
    chat: String(message.chat.id),
    direct: message.chat.type === "private",
  };
  const command = message.text ? COMMAND.exec(message.text.trim()) : null;
  if (command) {
    const [, name, payload] = command;
    const code = name === "start" ? payload?.trim() || null : null;
    return void (await receive({
      kind: "hello",
      ...sender,
      code,
      ...(name === "pending" || name === "portfolio" ? { command: name } : {}),
    }));
  }
  await receive({
    kind: "message",
    id: refOf(message),
    ...sender,
    text,
    replyTo: message.reply_to_message
      ? refOf({ chat: message.chat, message_id: message.reply_to_message.message_id })
      : null,
  });
}

interface Form {
  readonly text: string;
  readonly parse_mode?: "HTML";
}

interface Piece {
  readonly text: string;
  readonly html: string;
}

/** Sends with formatting, and as plain text when Telegram can't parse what the markdown became. */
async function withPlainFallback<Result>(
  piece: Piece,
  send: (form: Form) => Promise<Result>,
): Promise<Result> {
  try {
    return await send({ text: piece.html, parse_mode: "HTML" });
  } catch (error) {
    if (error instanceof BotApiError && error.description.includes("can't parse entities"))
      return send({ text: piece.text });
    throw error;
  }
}

/**
 * A message's words and its inline keyboard. Auni names the computer in the message when it
 * has no phone address. Never turn a local-only button into a link in the message.
 */
function telegramForm(message: ChannelMessage): {
  readonly pieces: Piece[];
  readonly keyboard: { readonly inline_keyboard: unknown[][] } | null;
} {
  let localOnly = false;
  const rows = (message.buttons ?? [])
    .map((row) =>
      row.flatMap((button): Record<string, unknown>[] => {
        if ("press" in button) return [{ text: button.label, callback_data: button.press }];
        if ("copy" in button) return [{ text: button.label, copy_text: { text: button.copy } }];
        if (button.url.startsWith("https://") && webLink(button.url))
          return [{ text: button.label, url: button.url }];
        localOnly = true;
        return [];
      }),
    )
    .filter((row) => row.length > 0);
  const text = localOnly ? `${message.text}\n\nOpen Auni on your computer.` : message.text;
  const detail = message.detail?.trim();
  const pieces =
    detail && text.length + detail.length + 2 <= MESSAGE_CHARS
      ? [
          {
            text: [text, detail].filter(Boolean).join("\n\n"),
            html: [text ? toHtml(text, MESSAGE_CHARS - detail.length - 2) : "", detailHtml(detail)]
              .filter(Boolean)
              .join("\n\n"),
          },
        ]
      : [
          ...chunks(text).map((piece) => ({ text: piece, html: toHtml(piece) })),
          ...chunks(detail ?? "").map((piece) => ({ text: piece, html: detailHtml(piece) })),
        ];
  return {
    pieces,
    keyboard: rows.length > 0 ? { inline_keyboard: rows } : null,
  };
}
