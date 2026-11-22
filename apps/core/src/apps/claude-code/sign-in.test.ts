import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SignInShows } from "../contract.ts";

/**
 * A stand-in for the Claude Code Auni bundles, whose `auth login` speaks as the real one did with
 * no terminal attached (2.1.316): the page's address, the prompt, one line read, then its verdict.
 * It writes down what it was given, to show the owner's line reached it and nothing else did.
 */
const cli = vi.hoisted(() => ({ path: "", heard: "" }));
vi.mock("./cli.ts", () => ({ claudeCli: () => cli.path }));

const { signIn } = await import("./sign-in.ts");

function fakeClaude(): void {
  const dir = mkdtempSync(join(tmpdir(), "auni-claude-"));
  cli.path = join(dir, "claude");
  cli.heard = join(dir, "heard");
  writeFileSync(
    cli.path,
    `#!/bin/sh
echo "$*" > "${cli.heard}"
printf 'Opening browser to sign in\\342\\200\\246\\n'
printf 'If the browser didn'"'"'t open, visit: \\033[1mhttps://claude.com/cai/oauth/authorize?code=true\\033[0m\\n'
printf 'Paste code here if prompted > '
read code
echo "$code" >> "${cli.heard}"
if [ "$code" = "good#state" ]; then echo "Login successful."; exit 0; fi
echo "Login failed: That code wasn't accepted. Sign in again to get a new code."
exit 1
`,
  );
  chmodSync(cli.path, 0o755);
}

/** Runs a sign-in, typing `line` once the prompt is up; what it showed, and how it ended. */
async function signInTyping(line: string) {
  fakeClaude();
  const shown: SignInShows[] = [];
  let type: (line: string) => void = () => {};
  const ended = signIn({
    signal: new AbortController().signal,
    show: (view) => {
      shown.push(view);
      if (view.kind === "terminal" && view.output.endsWith("prompted > ")) type(line);
    },
    onTyped: (write) => (type = write),
  }).then(
    () => "signed in",
    (error: Error) => error.message,
  );
  return { ended: await ended, shown, heard: readFileSync(cli.heard, "utf8") };
}

describe.runIf(process.platform !== "win32")("Claude Code's sign-in from the web app", () => {
  it("shows the CLI's own words, plain, and hands the owner's line to its prompt", async () => {
    const { ended, shown, heard } = await signInTyping("good#state");
    expect(ended).toBe("signed in");
    expect(heard).toBe("auth login --claudeai\ngood#state\n");
    const last = shown.at(-1)!;
    expect(last).toEqual({
      kind: "terminal",
      command: "claude auth login",
      output:
        "Opening browser to sign in…\n" +
        "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\n" +
        "Paste code here if prompted > \nLogin successful.\n",
    });
  });

  it("never shows what was typed, and fails in the CLI's own words", async () => {
    const { ended, shown } = await signInTyping("stale#code");
    expect(ended).toBe("Login failed: That code wasn't accepted. Sign in again to get a new code.");
    expect(shown.some((view) => JSON.stringify(view).includes("stale"))).toBe(false);
  });
});
