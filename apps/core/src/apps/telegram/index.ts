import { setting } from "../../settings.ts";
import { defineApp } from "../contract.ts";
import { tryKeyAt } from "../../try-key.ts";
import { telegramChannel } from "./channel.ts";
import about from "./about.ts";

/**
 * Telegram: the owner talks to Auni through a bot of their own (TELEGRAM_BOT_TOKEN, from
 * BotFather), which Auni long-polls, so it needs no public URL.
 */
// Kept without a trailing slash, so every path joins on with exactly one.
const apiUrl = () => (setting(about, "apiUrl") ?? "https://api.telegram.org").replace(/\/+$/u, "");

export default defineApp({
  about,
  channel: telegramChannel({ token: () => setting(about, "botToken"), apiUrl }),
  // The bot the token is for. Telegram answers 404, not 401, for a token that isn't one at all.
  tryKey: (_key, value) => tryKeyAt(`${apiUrl()}/bot${value}/getMe`, {}, [401, 404]),
});
