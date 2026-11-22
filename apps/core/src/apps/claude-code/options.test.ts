import { describe, expect, it } from "vitest";

import type { Box } from "../../agent/box.ts";
import type { BrainTurn } from "../contract.ts";
import { secrets } from "./check.ts";
import { childEnv, claudeOptions, mcpConfig } from "./options.ts";

const box: Box = {
  workDir: "/home/owner/.auni-work",
  hidden: ["/home/owner", "/home/owner/.auni", "/run/user/1000"],
  readable: ["/home/owner/.auni-work", "/usr"],
};
const turn: BrainTurn = {
  systemPrompt: "You are Auni.",
  prompt: ["Hi"],
  role: "deep",
  box,
  mcp: { url: "http://127.0.0.1:4000/mcp", token: "turn-token" },
};

describe("the CLI's environment", () => {
  const shell = {
    PATH: "/usr/bin",
    HOME: "/home/owner",
    CLAUDE_CONFIG_DIR: "/home/owner/.config/claude",
    ANTHROPIC_API_KEY: "sk-ant-shell",
    ANTHROPIC_AUTH_TOKEN: "proxy-token",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "s",
    OPENAI_API_KEY: "sk-openai",
    DATABASE_URL: "postgres://secret",
    TURN_TOKEN_SECRET: "x".repeat(32),
    PRIVY_APP_SECRET: "privy",
    ALCHEMY_API_KEY: "alchemy",
    AWS_SECRET_ACCESS_KEY: "aws",
    GITHUB_TOKEN: "gh",
    SSH_AUTH_SOCK: "/run/user/1000/ssh",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
  };

  it("keeps the owner's own login where it is and hands on nothing of core's", () => {
    expect(childEnv(shell)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/owner",
      CLAUDE_CONFIG_DIR: "/home/owner/.config/claude",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "auni",
    });
  });

  it("bills an Anthropic key only when the owner gave Auni one", () => {
    process.env.AUNI_ANTHROPIC_API_KEY = "sk-ant-auni";
    try {
      expect(childEnv(shell).ANTHROPIC_API_KEY).toBe("sk-ant-auni");
    } finally {
      delete process.env.AUNI_ANTHROPIC_API_KEY;
    }
  });
});

describe("the locked box", () => {
  const configFile = "/home/owner/.auni/run/mcp-1.json";
  const options = claudeOptions(turn, {}, new AbortController(), 4100, configFile);

  it("sandboxes Bash with no way out, and denies whatever wasn't allowed unasked", () => {
    expect(options.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: { denyRead: box.hidden, allowRead: box.readable },
      // Every connection out goes through Auni's egress proxy, which judges the address dialled.
      network: { allowAllUnixSockets: false, httpProxyPort: 4100, socksProxyPort: 4100 },
    });
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  // WebFetch fetches from the CLI's own process, outside the sandbox and past the egress proxy.
  it("lets Read into the scratch folder alone, and offers no tool that writes or fetches", () => {
    expect(options.allowedTools).toEqual([
      "Bash",
      "Read(//home/owner/.auni-work/**)",
      "WebSearch",
      "mcp__auni",
    ]);
    expect(options.tools).toEqual(["Bash", "Read", "WebSearch"]);
    expect(JSON.stringify(options)).not.toContain("WebFetch");
  });

  it("loads none of the owner's own settings, servers or skills, and keeps no session", () => {
    expect(options).toMatchObject({
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      skills: [],
      cwd: box.workDir,
      model: "opus",
    });
  });

  // On the command line, any process of the owner's could read the turn's token.
  it("hands the CLI Auni's server by a file, never the token itself", () => {
    expect(options.extraArgs).toEqual({ "mcp-config": configFile });
    expect(options.mcpServers).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("turn-token");
    expect(JSON.parse(mcpConfig(turn.mcp!))).toEqual({
      mcpServers: {
        auni: {
          type: "http",
          url: "http://127.0.0.1:4000/mcp",
          headers: { authorization: "Bearer turn-token" },
          alwaysLoad: true,
        },
      },
    });
  });

  // --bare ignores the owner's subscription login, which is the one Auni means to use.
  it("never runs the CLI bare", () => {
    expect(JSON.stringify(options)).not.toContain("bare");
  });

  it("gives a turn without Auni's tools no tools at all", () => {
    const triage = claudeOptions(
      { ...turn, mcp: null, role: "fast" },
      {},
      new AbortController(),
      4100,
      null,
    );
    expect(triage.tools).toEqual([]);
    expect(triage.extraArgs).toEqual({});
    expect(triage.mcpServers).toBeUndefined();
    expect(triage.model).toBe("haiku");
  });

  // The history's breakpoint is an hour long (run.ts). On an API key the CLI would mark the
  // system prompt, which comes first, with five minutes, and the API refuses that order.
  it("makes the CLI's own cache breakpoints an hour long, on every login", () => {
    expect(options.settings).toMatchObject({ promptCacheTtl: "1h" });
  });

  it("hides the CLI's login from every box", () => {
    expect(secrets()).toContain(process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`);
  });
});
