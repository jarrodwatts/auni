import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Claude Code Auni bundles, whose `auth status --json` says what the real one
 * did (2.1.316): the same JSON either way, and exit 1 when no one is signed in.
 */
const cli = vi.hoisted(() => ({ path: "" }));
vi.mock("./cli.ts", () => ({ claudeCli: () => cli.path }));

const { check } = await import("./check.ts");

function claudeThatSays(status: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "auni-claude-"));
  const file = join(dir, "claude");
  writeFileSync(
    file,
    `#!/bin/sh\n[ "$*" = "auth status --json" ] || exit 2\necho '${JSON.stringify(status)}'\nexit ${status.loggedIn ? 0 : 1}\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** A PATH holding only these commands. */
function pathWith(...commands: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "auni-path-"));
  for (const command of commands) {
    writeFileSync(join(dir, command), "#!/bin/sh\n");
    chmodSync(join(dir, command), 0o755);
  }
  return dir;
}

const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
});

const run = () => check(new AbortController().signal);
const signedOut = { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };

describe.runIf(process.platform === "linux")("the Claude Code check", () => {
  it("asks for the sandbox first, which only the owner can install", async () => {
    process.env.PATH = pathWith();
    cli.path = claudeThatSays(signedOut);
    expect(await run()).toEqual({
      ready: false,
      why: "not-installed",
      fix: "sudo apt-get install bubblewrap socat",
    });
  });

  it("is signed out, not uninstalled, with no claude command: Auni bundles one", async () => {
    process.env.PATH = pathWith("bwrap", "socat");
    cli.path = claudeThatSays(signedOut);
    expect(await run()).toEqual({
      ready: false,
      why: "signed-out",
      fix: "curl -fsSL https://claude.ai/install.sh | bash, then claude auth login",
    });
  });

  it("says only to log in where Claude Code is installed", async () => {
    process.env.PATH = pathWith("bwrap", "socat", "claude");
    cli.path = claudeThatSays(signedOut);
    expect(await run()).toEqual({ ready: false, why: "signed-out", fix: "claude auth login" });
  });

  it("is ready on the owner's plan, signed in as their email", async () => {
    process.env.PATH = pathWith("bwrap", "socat");
    cli.path = claudeThatSays({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "sam@example.com",
      subscriptionType: "max",
    });
    expect(await run()).toEqual({
      ready: true,
      login: "your Claude Max subscription",
      signedInAs: "sam@example.com",
    });
  });

  it("is ready on an API key, whoever's account it is", async () => {
    process.env.PATH = pathWith("bwrap", "socat");
    cli.path = claudeThatSays({
      loggedIn: true,
      authMethod: "api_key",
      apiKeySource: "ANTHROPIC_API_KEY",
    });
    expect(await run()).toEqual({ ready: true, login: "Auni's Anthropic API key" });
  });
});
