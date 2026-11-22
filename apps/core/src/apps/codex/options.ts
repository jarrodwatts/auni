import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { toolsDir } from "../../data-dir.ts";
import type { BrainTurn, Role } from "../contract.ts";

/** Where the owner's Codex keeps its login, config and own instructions. */
export function codexHome(from: NodeJS.ProcessEnv = process.env): string {
  return from.CODEX_HOME ?? join(homedir(), ".codex");
}

/** The app-server reads Auni's MCP token from here; the sandboxed shell never inherits it. */
export const TOKEN_VAR = "AUNI_TURN_TOKEN";

/**
 * All the CLI is handed of core's environment. Never a copy: core's holds the database, the
 * turn token's secret and whatever the owner's shell exported, an OPENAI_API_KEY among them.
 */
const KEEP = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  // Where the owner's Codex keeps its login, when not ~/.codex.
  "CODEX_HOME",
] as const;

export function childEnv(
  token: string | null,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const kept = Object.fromEntries(KEEP.flatMap((key) => (from[key] ? [[key, from[key]]] : [])));
  return token ? { ...kept, [TOKEN_VAR]: token } : kept;
}

/** The Codex Auni installs for the owner when they have none (install.ts), as tested with. */
export const CODEX_PACKAGE = "@openai/codex@0.164.0";

/** What the owner runs in a terminal to install Codex themselves. */
export const INSTALL_FIX = "npm install -g @openai/codex";

/**
 * The `codex` command Auni runs: the owner's own on the PATH, else the one Auni installed in its
 * tools folder (install.ts); null with neither.
 */
export function codexCommand(path = process.env.PATH ?? ""): string | null {
  for (const dir of [...path.split(delimiter), join(toolsDir(), "bin")]) {
    const candidate = dir && join(dir, "codex");
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The install a `codex` command runs from. Its sandbox runs the codex binary again inside the box
 * to lock each command down, so the box can't hide it, even when it sits in the home folder (the
 * standalone installer puts it under ~/.codex/packages).
 */
export function codexInstall(command: string): string {
  // bin/codex in its release folder (standalone) or its npm package (bin/codex.js).
  return dirname(dirname(realpathSync(command)));
}

/**
 * The box's hidden paths as Codex can enforce them. Codex 0.164 lets a "write" rule reopen a
 * folder inside a denied one but not a "read" rule, and a read-only box must not grant writes.
 * So each hidden folder holding something that must stay readable (the scratch folder in the
 * data folder, node or codex itself under home) is hidden entry by entry instead, down to it.
 * Symlinks are left alone: what they point to is hidden, or not, in its own right.
 */
export function hiddenEntries(
  hidden: readonly string[],
  readable: readonly string[],
  entries: (dir: string) => readonly string[] = (dir) => readdirSync(dir),
  isLink: (path: string) => boolean = (path) => lstatSync(path).isSymbolicLink(),
): string[] {
  const denied = new Set<string>();
  const hide = (path: string) => {
    if (!readable.some((open) => open.startsWith(`${path}/`))) return void denied.add(path);
    for (const name of entries(path)) {
      const child = join(path, name);
      if (!readable.includes(child) && !isLink(child)) hide(child);
    }
  };
  for (const path of hidden) hide(path);
  // Inside an already hidden folder there is nothing left to hide, and the sandbox can't mount there.
  const all = [...denied].sort();
  return all.filter((path) => !all.some((outer) => path.startsWith(`${outer}/`)));
}

/** A TOML string, which a JSON string of a path or plain text always is. */
const toml = (value: string) => JSON.stringify(value);

/**
 * The config overrides for one turn's app-server: the locked box. Shell commands run in Codex's
 * own read-only sandbox with no network and nothing the box hides; web search and Auni's MCP
 * server run outside it, in the app-server. None of the owner's own MCP servers, plugins, apps,
 * hooks, memories, skills, subagents or shell profile, and nothing kept after the turn.
 */
export function codexArgs(turn: BrainTurn, install: string): string[] {
  const readable = [...turn.box.readable, install];
  const hidden = hiddenEntries(
    turn.box.hidden.filter((path) => existsSync(path)),
    readable,
  );
  const filesystem = `{${hidden.map((path) => `${toml(path)}="deny"`).join(",")}}`;
  const tools = turn.mcp !== null;
  const config = [
    `default_permissions="auni"`,
    `permissions.auni.extends=":read-only"`,
    `permissions.auni.filesystem=${filesystem}`,
    `permissions.auni.network.enabled=false`,
    `approval_policy="never"`,
    `web_search=${tools ? `"live"` : `"disabled"`}`,
    `history.persistence="none"`,
    `project_doc_max_bytes=0`,
    `shell_environment_policy.inherit="core"`,
    `model_reasoning_summary="concise"`,
    // The shell snapshot runs the owner's login shell outside the box and replays what it
    // exported inside it, which could carry a token from their shell profile into the box.
    `features.shell_snapshot=false`,
    ...[
      "apps",
      "plugins",
      "remote_plugin",
      "tool_suggest",
      "hooks",
      "memories",
      "multi_agent",
      "goals",
      "image_generation",
      "browser_use",
      "computer_use",
      "skill_mcp_dependency_install",
    ].map((feature) => `features.${feature}=false`),
    `skills.bundled.enabled=false`,
    `skills.include_instructions=false`,
    // A turn without Auni's tools gets none at all: just the answer.
    ...(tools
      ? [
          `mcp_servers.auni.url=${toml(turn.mcp!.url)}`,
          `mcp_servers.auni.bearer_token_env_var="${TOKEN_VAR}"`,
          `mcp_servers.auni.required=true`,
          `mcp_servers.auni.default_tools_approval_mode="approve"`,
          `mcp_servers.auni.tool_timeout_sec=120`,
        ]
      : ["shell_tool", "unified_exec", "view_image"].map((feature) => `features.${feature}=false`)),
  ];
  return config.flatMap((setting) => ["-c", setting]);
}

/** A model's reasoning efforts, as model/list gives them. */
export interface ModelChoice {
  readonly model: string;
  readonly supportedReasoningEfforts: readonly { readonly reasoningEffort: string }[];
  readonly defaultReasoningEffort: string;
}

/**
 * Codex has one default model per login and thinks harder or faster with effort, so a role is
 * an effort: fast is its lowest, everyday its default, deep high (or the default without one).
 */
export function effortFor(role: Role, model: ModelChoice): string {
  const efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (role === "fast") return efforts[0] ?? model.defaultReasoningEffort;
  if (role === "deep" && efforts.includes("high")) return "high";
  return model.defaultReasoningEffort;
}
