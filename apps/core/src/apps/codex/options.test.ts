import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { theBox, type Box } from "../../agent/box.ts";
import { dataDir } from "../../data-dir.ts";
import type { BrainTurn } from "../contract.ts";
import { secrets } from "./check.ts";
import { childEnv, codexArgs, codexHome, effortFor, hiddenEntries, TOKEN_VAR } from "./options.ts";

describe("the app-server's environment", () => {
  const shell = {
    PATH: "/usr/bin",
    HOME: "/home/owner",
    USER: "owner",
    LANG: "en_US.UTF-8",
    CODEX_HOME: "/home/owner/.codex",
    OPENAI_API_KEY: "sk-openai",
    OPENAI_BASE_URL: "https://proxy.example",
    ANTHROPIC_AUTH_TOKEN: "proxy-token",
    DATABASE_URL: "postgres://secret",
    TURN_TOKEN_SECRET: "x".repeat(32),
    PRIVY_APP_SECRET: "privy",
    ALCHEMY_API_KEY: "alchemy",
    GITHUB_TOKEN: "gh",
    SSH_AUTH_SOCK: "/run/user/1000/ssh",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
  };

  it("keeps the owner's own login where it is, adds the turn's token, and hands on nothing of core's", () => {
    expect(childEnv("turn-token", shell)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/owner",
      USER: "owner",
      LANG: "en_US.UTF-8",
      CODEX_HOME: "/home/owner/.codex",
      [TOKEN_VAR]: "turn-token",
    });
    expect(childEnv(null, shell)).not.toHaveProperty(TOKEN_VAR);
  });

  it("hides the CLI's login from every box", () => {
    expect(codexHome({ HOME: "/home/owner" })).toMatch(/\.codex$/u);
    expect(codexHome({ CODEX_HOME: "/elsewhere" })).toBe("/elsewhere");
    expect(secrets()).toEqual([codexHome()]);
  });
});

describe("hiding what the box hides, as Codex can", () => {
  const tree: Record<string, string[]> = {
    "/home/owner": [".auni", ".auni-work", ".codex", ".ssh", "notes.txt", "link"],
    "/home/owner/.auni": ["wallet-keys.json"],
    "/home/owner/.codex": ["auth.json", "packages"],
    "/home/owner/.codex/packages": ["release"],
  };
  const entries = (dir: string) => tree[dir] ?? [];
  const isLink = (path: string) => path.endsWith("/link");

  it("hides a folder whole, or entry by entry down to what must stay readable", () => {
    expect(
      hiddenEntries(
        ["/home/owner", "/home/owner/.auni", "/home/owner/.codex", "/run/user/1000"],
        ["/home/owner/.auni-work", "/home/owner/.codex/packages/release"],
        entries,
        isLink,
      ),
    ).toEqual([
      "/home/owner/.auni",
      "/home/owner/.codex/auth.json",
      "/home/owner/.ssh",
      "/home/owner/notes.txt",
      "/run/user/1000",
    ]);
  });

  // A list of the data folder's entries is taken as the turn starts, and would miss a file made
  // in it later, such as the keys file on a first move.
  it("hides the data folder whole, since the scratch folder sits beside it", () => {
    const box = theBox([]);
    expect(box.workDir.startsWith(`${dataDir()}/`)).toBe(false);
    expect(hiddenEntries([dataDir()], box.readable)).toEqual([dataDir()]);
  });

  it("hides it whole when Node is an install's own, inside it, too", () => {
    const real = process.execPath;
    const node = join(dataDir(), "app/node/24.22.2/bin/node");
    mkdirSync(dirname(node), { recursive: true });
    Object.defineProperty(process, "execPath", { value: node });
    try {
      expect(hiddenEntries([dataDir()], theBox([]).readable)).toEqual([dataDir()]);
    } finally {
      Object.defineProperty(process, "execPath", { value: real });
    }
  });

  it("keeps hidden what is hidden in its own right, even inside what is readable", () => {
    expect(hiddenEntries(["/opt/node/secret"], ["/opt/node"], entries, isLink)).toEqual([
      "/opt/node/secret",
    ]);
  });
});

describe("the locked box", () => {
  const box: Box = {
    workDir: "/nowhere/.auni-work",
    hidden: ["/nowhere", "/nowhere/.auni"],
    readable: ["/nowhere/.auni-work"],
  };
  const turn: BrainTurn = {
    systemPrompt: "You are Auni.",
    prompt: ["Hi"],
    role: "deep",
    box,
    mcp: { url: "http://127.0.0.1:4000/mcp", token: "turn-token" },
  };
  const settings = (args: readonly string[]) => args.filter((arg) => arg !== "-c");

  it("runs every shell command read-only, offline, and denied what the box hides", () => {
    const args = codexArgs(turn, "/opt/codex");
    expect(args.filter((arg) => arg === "-c")).toHaveLength(args.length / 2);
    expect(settings(args)).toEqual(
      expect.arrayContaining([
        `default_permissions="auni"`,
        `permissions.auni.extends=":read-only"`,
        `permissions.auni.network.enabled=false`,
        `approval_policy="never"`,
        `shell_environment_policy.inherit="core"`,
        `features.shell_snapshot=false`,
        `history.persistence="none"`,
      ]),
    );
    // Nothing in the test's box exists on this machine, so there is nothing to deny.
    expect(settings(args)).toContain(`permissions.auni.filesystem={}`);
  });

  it("loads none of the owner's own plugins, apps, hooks, memories, skills or subagents", () => {
    expect(settings(codexArgs(turn, "/opt/codex"))).toEqual(
      expect.arrayContaining([
        "features.apps=false",
        "features.plugins=false",
        "features.hooks=false",
        "features.memories=false",
        "features.multi_agent=false",
        "skills.bundled.enabled=false",
        "skills.include_instructions=false",
      ]),
    );
  });

  it("reaches Auni's tools with the token from its environment, never on the command line", () => {
    const args = settings(codexArgs(turn, "/opt/codex"));
    expect(args).toEqual(
      expect.arrayContaining([
        `mcp_servers.auni.url="http://127.0.0.1:4000/mcp"`,
        `mcp_servers.auni.bearer_token_env_var="${TOKEN_VAR}"`,
        `mcp_servers.auni.required=true`,
        `web_search="live"`,
      ]),
    );
    expect(args.join(" ")).not.toContain("turn-token");
  });

  // Signing out would end the owner's own login, which Auni never touches.
  it("never signs the owner out", () => {
    expect(codexArgs(turn, "/opt/codex").join(" ")).not.toContain("sign-out");
  });

  it("gives a turn without Auni's tools no tools at all", () => {
    const args = settings(codexArgs({ ...turn, mcp: null }, "/opt/codex"));
    expect(args).toEqual(
      expect.arrayContaining([
        `web_search="disabled"`,
        "features.shell_tool=false",
        "features.unified_exec=false",
      ]),
    );
    expect(args.join(" ")).not.toContain("mcp_servers.auni");
  });
});

describe("roles as reasoning effort", () => {
  const model = {
    model: "gpt-6.1-sol",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({
      reasoningEffort,
    })),
    defaultReasoningEffort: "medium",
  };

  it("thinks least when fast, at the default every day, and high when deep", () => {
    expect(effortFor("fast", model)).toBe("low");
    expect(effortFor("everyday", model)).toBe("medium");
    expect(effortFor("deep", model)).toBe("high");
    expect(
      effortFor("deep", { ...model, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }),
    ).toBe("medium");
  });
});
