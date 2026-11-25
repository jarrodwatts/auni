import {
  HeartPulse,
  Smartphone,
  Sparkles,
  UserRound,
  WalletMinimal,
  type LucideIcon,
} from "lucide-react";

import type { SettingsSection } from "@/lib/app-links";

/** One of Settings' panes, as its list shows it. */
export interface SettingsPane {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: LucideIcon;
  /** What's in it, under its name in the phone's list. */
  readonly holds: string;
}

export const SETTINGS_PANES: readonly SettingsPane[] = [
  {
    id: "you",
    label: "You",
    icon: UserRound,
    holds: "Your name, daily brief and what Auni knows about you",
  },
  { id: "ai", label: "Your AI", icon: Sparkles, holds: "The AI Auni thinks with" },
  {
    id: "wallet",
    label: "Your wallet",
    icon: WalletMinimal,
    holds: "Your addresses, money in and out, and your keys",
  },
  {
    id: "devices",
    label: "Your devices",
    icon: Smartphone,
    holds: "Your phone, Telegram and this computer",
  },
  { id: "health", label: "Health", icon: HeartPulse, holds: "Whether everything's working" },
];

/** One thing a search in Settings finds: where it is, and the words it's found by. */
export interface SettingsSearchItem {
  readonly section: SettingsSection;
  /** The id of the setting, group or disclosure it lands on. */
  readonly target: string;
  readonly title: string;
  readonly words: readonly string[];
}

export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    section: "you",
    target: "setting-name",
    title: "Your name",
    words: ["name", "profile", "call"],
  },
  {
    section: "you",
    target: "setting-time-zone",
    title: "Time zone",
    words: ["timezone", "clock", "time", "schedule"],
  },
  {
    section: "you",
    target: "setting-brief",
    title: "Daily brief",
    words: ["brief", "digest", "summary", "morning", "daily", "weekdays", "schedule"],
  },
  {
    section: "you",
    target: "setting-home",
    title: "Where Auni messages you",
    words: ["notifications", "alerts", "notices", "home channel", "telegram", "messages"],
  },
  {
    section: "you",
    target: "setting-known",
    title: "What Auni knows about you",
    words: ["memory", "context", "profile", "interests", "personalization", "summary"],
  },
  {
    section: "you",
    target: "setting-x",
    title: "Your X handle",
    words: ["twitter", "x", "social", "handle", "personalization", "ideas"],
  },
  {
    section: "you",
    target: "setting-watched",
    title: "Wallets Auni watches",
    words: ["watch", "watch-only", "wallet", "metamask", "rabby", "ens", "holdings", "elsewhere"],
  },
  {
    section: "you",
    target: "setting-look",
    title: "Light or dark",
    words: ["theme", "dark", "light", "look", "appearance", "mode", "colour", "color"],
  },
  {
    section: "you",
    target: "setting-thinking",
    title: "Show Auni's thinking",
    words: ["thinking", "reasoning", "steps", "chat"],
  },
  {
    section: "ai",
    target: "setting-brains",
    title: "Your AI",
    words: ["brain", "ai", "claude", "codex", "chatgpt", "model", "sign in", "login", "install"],
  },
  {
    section: "ai",
    target: "setting-first-brain",
    title: "Which AI goes first",
    words: ["preferred", "brain", "claude", "codex", "order", "usage limit", "fallback"],
  },
  {
    section: "wallet",
    target: "setting-addresses",
    title: "Your addresses",
    words: ["address", "evm", "solana", "deposit", "receive", "copy", "monad", "base"],
  },
  {
    section: "wallet",
    target: "setting-wallet-moves",
    title: "Add money or withdraw",
    words: ["add money", "deposit", "fund", "withdraw", "send", "cash out"],
  },
  {
    section: "wallet",
    target: "setting-keys",
    title: "Show your keys",
    words: ["keys", "private key", "backup", "export", "seed", "reveal", "solana key", "import"],
  },
  {
    section: "devices",
    target: "setting-phone",
    title: "Use Auni on your phone",
    words: ["phone", "mobile", "tailscale", "remote", "https", "qr", "away", "laptop"],
  },
  {
    section: "devices",
    target: "setting-running",
    title: "Keep Auni running",
    words: ["always on", "background", "service", "reboot", "systemd", "launchd", "sleep"],
  },
  {
    section: "devices",
    target: "setting-telegram",
    title: "Telegram",
    words: ["telegram", "chat", "bot", "channel", "messaging", "pair"],
  },
  {
    section: "devices",
    target: "setting-browsers",
    title: "Signed-in browsers",
    words: ["pair", "pairing link", "sign in", "browsers", "sessions", "sign out", "revoke"],
  },
  {
    section: "devices",
    target: "setting-handover",
    title: "Move Auni to another computer",
    words: ["handover", "move", "migrate", "server", "mac mini", "always on", "computer"],
  },
  {
    section: "health",
    target: "setting-checks",
    title: "Health checks",
    words: ["doctor", "health", "fix", "repair", "check", "broken", "diagnostics", "problem"],
  },
  {
    section: "health",
    target: "setting-version",
    title: "Version and updates",
    words: ["version", "update", "upgrade", "release", "about"],
  },
  {
    section: "health",
    target: "setting-help",
    title: "Get help",
    words: ["help", "bug", "report", "issue", "github", "source", "security"],
  },
  {
    section: "health",
    target: "setting-networks",
    title: "Networks",
    words: ["rpc", "alchemy", "api key", "node", "network", "custom rpc", "chain", "developers"],
  },
  {
    section: "health",
    target: "setting-logs",
    title: "Logs",
    words: ["logs", "debug", "errors", "triage", "developers"],
  },
  {
    section: "health",
    target: "setting-backup",
    title: "Back up and restore",
    words: ["export", "import", "backup", "restore", "developers"],
  },
];

export function paneOf(section: SettingsSection): SettingsPane {
  return SETTINGS_PANES.find(({ id }) => id === section)!;
}

/**
 * What a search finds: every item that has each word typed, in its title, its words or its
 * pane's name; one whose title starts with what was typed first.
 */
export function searchSettings(query: string): readonly SettingsSearchItem[] {
  const typed = query.trim().toLowerCase();
  if (!typed) return [];
  const tokens = typed.split(/\s+/u);
  const scored = SETTINGS_SEARCH_ITEMS.flatMap((item) => {
    const title = item.title.toLowerCase();
    const words = item.words.join(" ");
    const hay = `${title} ${words} ${paneOf(item.section).label.toLowerCase()}`;
    if (!tokens.every((token) => hay.includes(token))) return [];
    const score = title.startsWith(typed)
      ? 3
      : title.includes(typed)
        ? 2
        : item.words.some((word) => word.startsWith(typed))
          ? 1
          : 0;
    return [{ item, score }];
  });
  return scored.toSorted((a, b) => b.score - a.score).map(({ item }) => item);
}
