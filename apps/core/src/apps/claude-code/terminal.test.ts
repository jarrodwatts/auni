import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeCli } from "./cli.ts";
import { terminal } from "./terminal.ts";

afterEach(() => vi.unstubAllEnvs());

/** A PATH holding only `command`, as an owner's with it installed would. */
function pathWith(command: string | null): void {
  const bin = mkdtempSync(join(tmpdir(), "auni-path-"));
  if (command) {
    writeFileSync(join(bin, command), "#!/bin/sh\n");
    chmodSync(join(bin, command), 0o755);
  }
  vi.stubEnv("PATH", bin);
}

describe("Claude Code in the owner's terminal", () => {
  it("starts their claude on the prompt, its file tools denied what triage hides, asking first", () => {
    pathWith("claude");
    const [command, ...args] = terminal("Read the playbook", ["/me/.auni/.env", "/me/.auni/run"])!;
    expect(command).toBe("claude");
    expect(args.at(-1)).toBe("Read the playbook");
    // Asks before each command and edit their own rules don't allow, whatever mode they keep.
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(//me/.auni/.env)",
        "Edit(//me/.auni/.env)",
        "Read(//me/.auni/run/**)",
        "Edit(//me/.auni/run/**)",
      ]),
    );
  });

  it("starts the Claude Code Auni bundles where the owner hasn't installed claude", () => {
    pathWith(null);
    expect(terminal("Read the playbook", [])?.[0]).toBe(claudeCli());
  });
});
