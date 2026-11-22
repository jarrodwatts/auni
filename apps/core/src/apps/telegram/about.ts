import type { AppAbout } from "@auni/shared";

export default {
  id: "telegram",
  name: "Telegram",
  does: "Chat with Auni there",
  mark: { background: "#e9f6fd", ring: "rgb(38 165 228 / 0.18)", fit: "contain", size: 0.72 },
  settings: {
    // A bot of the owner's own (BotFather's token) to talk to Auni in; unset, no Telegram.
    // `auni pair --channel telegram` pairs the owner's account with it.
    botToken: {
      env: "TELEGRAM_BOT_TOKEN",
      label: "Telegram bot token",
      kind: "secret",
      required: true,
      help: "Make a bot with @BotFather in Telegram and paste the token it gives you.",
      link: "https://t.me/BotFather",
    },
    // Only for a Bot API server of the owner's own; unset, Telegram's. It says who Auni's
    // messages and cards go through, so it is set in the settings file alone.
    apiUrl: { env: "TELEGRAM_API_URL", label: "Bot API server", kind: "file" },
  },
} satisfies AppAbout;
