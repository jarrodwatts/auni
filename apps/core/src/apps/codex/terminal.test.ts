import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../../test/temp-dir.ts";
import { toolsDir } from "../../data-dir.ts";
import { terminal } from "./terminal.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Codex in the owner's terminal", () => {
  it("starts their codex on the prompt, in a read-only sandbox that can't read what triage hides", () => {
    const root = tempDir("auni-codex-");
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/codex"), "#!/bin/sh\n");
    chmodSync(join(root, "bin/codex"), 0o755);
    vi.stubEnv("PATH", join(root, "bin"));
    const settings = join(root, ".env");
    writeFileSync(settings, "TELEGRAM_BOT_TOKEN=x\n");

    const [command, ...args] = terminal("Read the playbook", [settings, join(root, "gone")])!;
    expect(command).toBe(join(root, "bin/codex"));
    expect(args.at(-1)).toBe("Read the playbook");
    // Each a config override; a path that isn't there gets no rule, which Codex would refuse.
    expect(args.slice(0, -1).filter((_, at) => at % 2 === 1)).toEqual([
      `default_permissions="triage"`,
      `permissions.triage.extends=":read-only"`,
      `permissions.triage.filesystem={${JSON.stringify(settings)}="deny"}`,
      `permissions.triage.network.enabled=true`,
    ]);
  });

  it("starts the codex Auni installed in its tools folder, off the owner's PATH", () => {
    vi.stubEnv("PATH", tempDir("auni-path-"));
    vi.stubEnv("AUNI_HOME", join(tempDir("auni-home-"), "data"));
    expect(terminal("Read the playbook", [])).toBeNull();
    mkdirSync(join(toolsDir(), "bin"), { recursive: true });
    writeFileSync(join(toolsDir(), "bin/codex"), "#!/bin/sh\n");
    chmodSync(join(toolsDir(), "bin/codex"), 0o755);
    expect(terminal("Read the playbook", [])?.[0]).toBe(join(toolsDir(), "bin/codex"));
  });
});
