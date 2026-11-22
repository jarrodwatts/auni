import {
  Cpu,
  GlobeLock,
  Info,
  MessageSquare,
  Network,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  WalletMinimal,
  type LucideIcon,
} from "lucide-react";

import type { SettingsSection } from "@/lib/app-links";

export interface SettingsSectionMeta {
  readonly id: SettingsSection;
  readonly label: string;
  readonly group: string | null;
  readonly icon: LucideIcon;
  readonly description: string;
}

export const SETTINGS_SECTIONS_META: readonly SettingsSectionMeta[] = [
  {
    id: "general",
    label: "General",
    group: null,
    icon: SlidersHorizontal,
    description: "Your name, time zone, daily brief schedule, and chat display preferences.",
  },
  {
    id: "appearance",
    label: "Appearance",
    group: null,
    icon: Palette,
    description: "Choose how Auni looks across your browser and paired devices.",
  },
  {
    id: "personalization",
    label: "Personalization",
    group: null,
    icon: Sparkles,
    description:
      "Connect read-only signals so Auni tailors starting ideas and research without questionnaires.",
  },
  {
    id: "brains",
    label: "AI Brains",
    group: "Agent & Money",
    icon: Cpu,
    description: "Manage the local AI CLIs Auni thinks with and pick which one runs first.",
  },
  {
    id: "wallet",
    label: "Wallet & Keys",
    group: "Agent & Money",
    icon: WalletMinimal,
    description: "Your local self-custody wallet addresses, withdrawals, and key backups.",
  },
  {
    id: "channels",
    label: "Channels",
    group: "Agent & Money",
    icon: MessageSquare,
    description: "Connect chat apps and choose where Auni sends alerts and daily briefs.",
  },
  {
    id: "remote",
    label: "Remote access",
    group: "Local & Remote",
    icon: GlobeLock,
    description:
      "Reach Auni from your phone via Tailscale HTTPS, keep it running in the background, and manage paired browsers.",
  },
  {
    id: "network",
    label: "Network & RPCs",
    group: "Local & Remote",
    icon: Network,
    description: "Configure an Alchemy API key or custom RPC endpoints for any chain.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    group: "System",
    icon: Stethoscope,
    description: "Run live health checks, apply safe repairs, inspect logs, and triage issues.",
  },
  {
    id: "about",
    label: "About",
    group: "System",
    icon: Info,
    description: "Running version, updates, local data paths, and open-source project links.",
  },
];

export interface SettingsSearchItem {
  readonly id: string;
  readonly section: SettingsSection;
  readonly targetId: string;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: "general-name",
    section: "general",
    targetId: "setting-name",
    title: "Display name",
    description: "What Auni calls you in chat",
    keywords: ["name", "profile", "owner", "identity"],
  },
  {
    id: "general-timezone",
    section: "general",
    targetId: "setting-timezone",
    title: "Time zone",
    description: "Used for schedules, watches, and daily briefs",
    keywords: ["timezone", "clock", "time", "schedule"],
  },
  {
    id: "general-brief",
    section: "general",
    targetId: "setting-brief",
    title: "Daily brief",
    description: "Schedule when Auni sends a morning summary",
    keywords: ["brief", "digest", "summary", "morning", "daily", "weekdays", "schedule"],
  },
  {
    id: "general-thinking",
    section: "general",
    targetId: "setting-thinking",
    title: "Show Auni's thinking",
    description: "Display intermediate reasoning steps in chat",
    keywords: ["thinking", "reasoning", "steps", "chat", "verbose"],
  },
  {
    id: "general-wizard",
    section: "general",
    targetId: "setting-wizard",
    title: "Re-run setup wizard",
    description: "Open the local onboarding wizard again",
    keywords: ["onboarding", "wizard", "welcome", "first run", "setup"],
  },
  {
    id: "appearance-theme",
    section: "appearance",
    targetId: "setting-theme",
    title: "Theme & look",
    description: "Switch between Light, Dark, or app themes",
    keywords: ["theme", "dark", "light", "look", "color", "mode", "appearance"],
  },
  {
    id: "personalization-profile",
    section: "personalization",
    targetId: "setting-profile-summary",
    title: "What Auni knows about you",
    description: "Inspect, edit, or clear Auni's inferred context",
    keywords: ["memory", "context", "profile", "beliefs", "interests", "bio", "summary"],
  },
  {
    id: "personalization-x",
    section: "personalization",
    targetId: "setting-x-handle",
    title: "X / Twitter handle",
    description: "Public handle used to infer themes and tailor prompts",
    keywords: ["twitter", "x", "social", "handle", "prompts", "recommended"],
  },
  {
    id: "personalization-watched",
    section: "personalization",
    targetId: "setting-watched-wallets",
    title: "Watch-only wallets",
    description: "Connect MetaMask/Rabby or paste EVM, ENS, or Solana addresses",
    keywords: ["watch", "wallet", "metamask", "rabby", "ens", "holdings", "portfolio", "external"],
  },
  {
    id: "brains-preferred",
    section: "brains",
    targetId: "setting-preferred-brain",
    title: "Preferred AI brain",
    description: "Choose which AI CLI runs first with automatic fallback",
    keywords: ["brain", "ai", "model", "cli", "claude", "codex", "provider", "login", "sign in"],
  },
  {
    id: "wallet-addresses",
    section: "wallet",
    targetId: "setting-wallet-addresses",
    title: "Wallet addresses",
    description: "Your local EVM and Solana addresses",
    keywords: ["address", "evm", "solana", "deposit", "fund", "balance"],
  },
  {
    id: "wallet-withdraw",
    section: "wallet",
    targetId: "setting-wallet-actions",
    title: "Withdraw & wallet keys",
    description: "Move money out, add a missing chain key, or reveal private keys",
    keywords: ["withdraw", "keys", "private key", "backup", "export", "seed", "solana"],
  },
  {
    id: "channels-home",
    section: "channels",
    targetId: "setting-home-channel",
    title: "When Auni speaks up",
    description: "Choose where unasked alerts and daily briefs are delivered",
    keywords: ["notifications", "alerts", "home channel", "notices", "brief"],
  },
  {
    id: "channels-apps",
    section: "channels",
    targetId: "setting-channel-apps",
    title: "Chat apps",
    description: "Configure bot tokens and pair direct chats",
    keywords: ["telegram", "chat", "bot", "channel", "messaging", "pair"],
  },
  {
    id: "remote-tailscale",
    section: "remote",
    targetId: "setting-tailscale",
    title: "Tailscale HTTPS",
    description: "Reach Auni securely from your phone or laptop over your tailnet",
    keywords: ["tailscale", "remote", "phone", "mobile", "https", "serve", "qr", "tailnet"],
  },
  {
    id: "remote-service",
    section: "remote",
    targetId: "setting-service",
    title: "Background service (Always on)",
    description: "Run Auni as a systemd or launchd service so it stays awake",
    keywords: ["service", "always on", "systemd", "launchd", "linger", "background", "daemon"],
  },
  {
    id: "remote-sessions",
    section: "remote",
    targetId: "setting-sessions",
    title: "Paired devices & browsers",
    description: "Mint a pairing link or QR code and revoke connected browsers",
    keywords: ["pair", "pairing", "qr", "sessions", "browsers", "devices", "revoke", "sign out"],
  },
  {
    id: "remote-handover",
    section: "remote",
    targetId: "setting-handover",
    title: "Move to another machine",
    description: "Hand Auni over to an always-on Linux or Mac machine on Tailscale",
    keywords: ["handover", "migrate", "move", "server", "vps", "mac mini", "laptop"],
  },
  {
    id: "network-alchemy",
    section: "network",
    targetId: "setting-alchemy",
    title: "Alchemy API key",
    description: "Reliable RPCs across all supported chains with one key",
    keywords: ["alchemy", "rpc", "api key", "node", "rate limit"],
  },
  {
    id: "network-chains",
    section: "network",
    targetId: "setting-chain-rpcs",
    title: "Per-chain RPC URLs",
    description:
      "Override the RPC endpoint for Monad, Base, Arbitrum, Polygon, Ethereum, or Solana",
    keywords: ["rpc", "custom rpc", "monad", "base", "arbitrum", "polygon", "ethereum", "solana"],
  },
  {
    id: "diagnostics-doctor",
    section: "diagnostics",
    targetId: "setting-doctor",
    title: "Health checks (auni doctor)",
    description: "Run diagnostics and apply one-click safe repairs",
    keywords: ["doctor", "health", "fix", "repair", "check", "broken", "troubleshoot"],
  },
  {
    id: "diagnostics-logs",
    section: "diagnostics",
    targetId: "setting-logs",
    title: "Recent logs",
    description: "Inspect redacted lines from ~/.auni/auni.log",
    keywords: ["logs", "debug", "errors", "auni.log", "triage"],
  },
  {
    id: "diagnostics-backup",
    section: "diagnostics",
    targetId: "setting-backup",
    title: "Export, import & triage",
    description: "CLI commands for backups and AI-assisted troubleshooting",
    keywords: ["export", "import", "backup", "triage", "help", "bug", "github", "issue"],
  },
  {
    id: "about-version",
    section: "about",
    targetId: "setting-version",
    title: "Version & updates",
    description: "Check for newer Auni releases and view local paths",
    keywords: ["version", "update", "upgrade", "github", "open source", "license", "paths"],
  },
];

export function sectionMeta(section: SettingsSection): SettingsSectionMeta {
  return SETTINGS_SECTIONS_META.find((item) => item.id === section) ?? SETTINGS_SECTIONS_META[0]!;
}

export function searchSettings(query: string): readonly SettingsSearchItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  const scored: { readonly item: SettingsSearchItem; readonly score: number }[] = [];

  for (const item of SETTINGS_SEARCH_ITEMS) {
    const title = item.title.toLowerCase();
    const desc = item.description.toLowerCase();
    const kw = item.keywords.join(" ").toLowerCase();
    const hay = `${title} ${desc} ${kw} ${item.section}`;
    if (!tokens.every((token) => hay.includes(token))) continue;

    let score = 1;
    if (title === normalized) score += 100;
    else if (title.startsWith(normalized)) score += 60;
    else if (title.includes(normalized)) score += 40;
    else if (kw.includes(normalized)) score += 25;
    scored.push({ item, score });
  }

  return scored.toSorted((a, b) => b.score - a.score).map(({ item }) => item);
}
