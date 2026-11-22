import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import type { BrainModelWire } from "@auni/shared";

import { scratchDir } from "../../agent/box.ts";
import type { BrainCheck } from "../contract.ts";
import { claudeCli } from "./cli.ts";
import { loginOf } from "./events.ts";
import { childEnv } from "./options.ts";

/** Aliases Claude Code resolves to the newest release of each tier the login can use. */
const CLAUDE_MODELS: readonly BrainModelWire[] = [
  {
    id: "opus",
    name: "Claude Opus",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    isDefault: true,
  },
  {
    id: "sonnet",
    name: "Claude Sonnet",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
  },
  {
    id: "haiku",
    name: "Claude Haiku",
    efforts: [],
  },
];

/** Where the owner's Claude Code keeps its login: hidden from every brain's box. */
export function secrets(): readonly string[] {
  return [
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    join(homedir(), ".claude.json"),
  ];
}

export function onPath(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, command)));
}

/** The command to log in with in a terminal, and to install Claude Code first where it isn't yet. */
function loginFix(): string {
  return onPath("claude")
    ? "claude auth login"
    : "curl -fsSL https://claude.ai/install.sh | bash, then claude auth login";
}

/** What `claude auth status --json` says (Claude Code 2.1.316), as far as Auni reads it. */
interface AuthStatus {
  readonly loggedIn: boolean;
  /** Where an API key it bills comes from, when it has one: "ANTHROPIC_API_KEY". */
  readonly apiKeySource?: string;
  /** A claude.ai login's email and plan: "max". */
  readonly email?: string | null;
  readonly subscriptionType?: string | null;
}

/** Who Claude Code is signed in as. It exits 1 when no one is, with the same JSON. */
async function authStatus(signal: AbortSignal): Promise<AuthStatus> {
  const said = await promisify(execFile)(claudeCli(), ["auth", "status", "--json"], {
    env: childEnv(),
    cwd: scratchDir(),
    signal,
  }).catch((error: unknown) => {
    const { code, stdout } = error as { code?: unknown; stdout?: string };
    if (code === 1 && stdout) return { stdout };
    throw error;
  });
  return JSON.parse(said.stdout) as AuthStatus;
}

/**
 * Whether the owner's Claude Code is logged in here, and whether its sandbox can start. Auni runs
 * the Claude Code its Agent SDK bundles, so this works before the owner installs one. The sandbox
 * comes first, as only the owner can install it, and signing in is one tap after.
 */
export async function check(signal: AbortSignal): Promise<BrainCheck> {
  // Claude Code's sandbox on Linux is bubblewrap, with socat carrying its network.
  if (platform() === "linux" && !(onPath("bwrap") && onPath("socat")))
    return { ready: false, why: "not-installed", fix: "sudo apt-get install bubblewrap socat" };
  const status = await authStatus(signal);
  if (!status.loggedIn) return { ready: false, why: "signed-out", fix: loginFix() };
  // A key bills every token, whatever plan the account has.
  if (status.apiKeySource)
    return { ready: true, login: loginOf(status.apiKeySource), models: CLAUDE_MODELS };
  const plan = status.subscriptionType
    ?.replace(/^claude[\s_]*/iu, "")
    .replace(/^\w/u, (first) => first.toUpperCase());
  return {
    ready: true,
    login: plan ? `your Claude ${plan} subscription` : "your Claude login",
    ...(status.email ? { signedInAs: status.email } : {}),
    models: CLAUDE_MODELS,
  };
}
