import type { HookCallbackMatcher, HookEvent, Options } from "@anthropic-ai/claude-agent-sdk";
import { AUNI_TOOL_NAMES } from "@auni/shared";

import { setting } from "../../settings.ts";
import type { BrainTurn, Role } from "../contract.ts";
import { MCP_PREFIX } from "./events.ts";
import about from "./about.ts";

/**
 * All the CLI is handed of core's environment. Never a copy: core's holds the database, the turn
 * token's secret and whatever the owner's shell exported, an ANTHROPIC_BASE_URL or AUTH_TOKEN
 * among them, which would send the owner's turns somewhere other than their own login.
 */
const KEEP = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  // Where the owner's own Claude Code keeps its login, when not ~/.claude.
  "CLAUDE_CONFIG_DIR",
] as const;

export function childEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(KEEP.flatMap((key) => (from[key] ? [[key, from[key]]] : [])));
  const apiKey = setting(about, "apiKey");
  return {
    ...kept,
    // The CLI keeps its own login out of what Bash sees.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Auni keeps its own memory; the CLI's would be kept under the owner's own login folder.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "auni",
    // Only a key the owner gave Auni for this, never one that happened to be exported.
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
  };
}

/** Aliases the CLI resolves to the newest model of each kind the login can use. */
const MODELS: Record<Role, string> = { deep: "opus", everyday: "sonnet", fast: "haiku" };

/** Auni's tools by their bare names too, as a skill names them, so either reaches the tool. */
const TOOL_ALIASES = Object.fromEntries(
  AUNI_TOOL_NAMES.map((name) => [name, `${MCP_PREFIX}${name}`]),
);

/**
 * Auni's MCP server as the CLI's `--mcp-config` reads it, turn token and all. run.ts keeps it in a
 * 0600 file in the data folder, which the box hides, since on the command line any process of
 * the owner's could read the token (`ps`), and the Agent SDK puts `mcpServers` there.
 */
export function mcpConfig(mcp: NonNullable<BrainTurn["mcp"]>): string {
  return JSON.stringify({
    mcpServers: {
      auni: {
        type: "http",
        url: mcp.url,
        headers: { authorization: `Bearer ${mcp.token}` },
        alwaysLoad: true,
      },
    },
  });
}

/**
 * The CLI's options for one turn: the locked box. Bash runs in Claude Code's own sandbox (it
 * refuses to start without one, and nothing may run outside it), which can't read what the box
 * hides or reach this machine's unix sockets, and whose only network is Auni's egress proxy
 * (agent/egress.ts): the public internet for research, and nothing on this machine or its
 * networks. The sandbox's own proxy judges hosts by name, which another spelling of the same
 * address (127.0.0.2, this machine's LAN address) walks past. The Read tool runs outside the
 * sandbox, so it may read only the scratch folder. WebFetch would fetch from outside it too, past
 * the egress proxy, so pages are read with curl instead. Every other tool use is denied unasked
 * (dontAsk), and Edit and Write aren't offered.
 */
/** Effort values Claude Code accepts. */
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function claudeOptions(
  turn: BrainTurn,
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
  abortController: AbortController,
  egressPort: number,
  /** The file holding mcpConfig(turn.mcp); null for a turn without Auni's tools. */
  mcpConfigFile: string | null,
): Options {
  // "//abs/**" is the rule syntax for an absolute path.
  const work = `/${turn.box.workDir}/**`;
  const model = turn.model ?? MODELS[turn.role];
  const effort =
    turn.effort && CLAUDE_EFFORTS.has(turn.effort) && model !== "haiku"
      ? (turn.effort as NonNullable<Options["effort"]>)
      : undefined;
  return {
    env: childEnv(),
    cwd: turn.box.workDir,
    systemPrompt: turn.systemPrompt,
    model,
    ...(effort ? { effort } : {}),
    // None of the owner's own settings, hooks, CLAUDE.md, MCP servers, skills or apiKeyHelper.
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    // Auni's skills come from load_skill; the CLI's own coding skills would only crowd the prompt.
    skills: [],
    // Auni's server and nothing else (strictMcpConfig), from its file; none on a turn without tools.
    extraArgs: mcpConfigFile ? { "mcp-config": mcpConfigFile } : {},
    toolAliases: TOOL_ALIASES,
    // Every tool's definition is sent with every request, so only the ones Auni uses (Read is
    // how it sees a PDF or image); a turn without Auni's tools gets none at all.
    tools: turn.mcp ? ["Bash", "Read", "WebSearch"] : [],
    permissionMode: "dontAsk",
    allowedTools: ["Bash", `Read(${work})`, "WebSearch", "mcp__auni"],
    settings: {
      includeGitInstructions: false,
      // The mode again here: a live turn's init frame still reported "default" with the flag
      // alone (asks were denied all the same, since no one is there to answer them).
      permissions: { defaultMode: "dontAsk" },
      // The history's breakpoint lasts an hour (run.ts), and the API refuses a turn whose
      // shorter breakpoint comes before a longer one. Left to itself, the CLI marks the system
      // prompt with five minutes on an API key, or on a subscription past its usage limits.
      promptCacheTtl: "1h",
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: { denyRead: [...turn.box.hidden], allowRead: [...turn.box.readable] },
      // Both ports, or the sandbox runs its own proxy for the other. Clients get an http:// proxy
      // URL even for ALL_PROXY, so nothing that matters speaks SOCKS, which this one doesn't.
      network: {
        allowAllUnixSockets: false,
        httpProxyPort: egressPort,
        socksProxyPort: egressPort,
      },
    },
    includePartialMessages: true,
    // Current models omit thinking text unless asked; the summary is what the web shows as thoughts.
    thinking: { type: "adaptive", display: "summarized" },
    hooks,
    ...(turn.outputSchema
      ? { outputFormat: { type: "json_schema", schema: turn.outputSchema } }
      : {}),
    abortController,
  };
}
