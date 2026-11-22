import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { starOnGitHub, starredOnGitHub } from "./github-star.ts";

// The owner's GitHub CLI, stood in for by a `gh` first on PATH that prints and exits as each
// test has it, and keeps the arguments it was run with.
describe.runIf(process.platform !== "win32")("the owner's GitHub CLI", () => {
  const bins: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const bin of bins.splice(0)) rmSync(bin, { recursive: true, force: true });
  });

  /** A `gh` that says `said` on stderr and exits `code`; null for no `gh` at all. */
  function gh(answer: { readonly code: number; readonly said?: string } | null) {
    const bin = mkdtempSync(join(tmpdir(), "auni-gh-"));
    bins.push(bin);
    vi.stubEnv("PATH", answer ? `${bin}:${process.env.PATH}` : bin);
    if (!answer) return () => "";
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nprintf '%s ' "$@" > "${bin}/args"\necho '${answer.said ?? ""}' >&2\nexit ${answer.code}\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    return () => readFileSync(join(bin, "args"), "utf8").trim();
  }

  it("asks GitHub whether Auni is starred, and reads its 204 and 404", async () => {
    const ran = gh({ code: 0 });
    expect(await starredOnGitHub()).toBe(true);
    expect(ran()).toBe("api --hostname github.com user/starred/jarrodwatts/auni");
    gh({ code: 1, said: "gh: Not Found (HTTP 404)" });
    expect(await starredOnGitHub()).toBe(false);
  });

  it("can't say when gh is missing, signed out or offline", async () => {
    gh(null);
    expect(await starredOnGitHub()).toBeNull();
    gh({ code: 4, said: "To get started with GitHub CLI, please run:  gh auth login" });
    expect(await starredOnGitHub()).toBeNull();
    gh({ code: 1, said: "error connecting to api.github.com" });
    expect(await starredOnGitHub()).toBeNull();
    gh({ code: 1, said: "gh: Server Error (HTTP 500)" });
    expect(await starredOnGitHub()).toBeNull();
  });

  it("stars Auni with a PUT, and says when it couldn't", async () => {
    const ran = gh({ code: 0 });
    expect(await starOnGitHub()).toBe(true);
    expect(ran()).toBe("api --hostname github.com -X PUT user/starred/jarrodwatts/auni");
    gh({ code: 4, said: "To get started with GitHub CLI, please run:  gh auth login" });
    expect(await starOnGitHub()).toBe(false);
    gh(null);
    expect(await starOnGitHub()).toBe(false);
  });
});
