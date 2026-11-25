import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "./test/temp-dir.ts";
import { canOpenBrowser, openBrowser } from "./open-browser.ts";

describe.runIf(process.platform === "linux")("openBrowser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  /** An xdg-open stand-in that exits with `code`. */
  function opener(code: number) {
    const bin = tempDir("auni-opener-");
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nexit ${code}\n`);
    chmodSync(join(bin, "xdg-open"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  }

  it("says it opened once the opener hands the link on", async () => {
    opener(0);
    await expect(openBrowser("http://localhost:3000/app#pair=code")).resolves.toBeUndefined();
  });

  it("fails when the opener does: a screen with no browser to hand it to", async () => {
    opener(3);
    await expect(openBrowser("http://localhost:3000/app#pair=code")).rejects.toThrow(/exited 3/u);
  });

  it("hands the link to Windows' own browser from WSL, which needs no screen of its own", async () => {
    vi.stubEnv("SSH_CONNECTION", "");
    vi.stubEnv("SSH_TTY", "");
    const bin = tempDir("auni-opener-");
    writeFileSync(join(bin, "cmd.exe"), `#!/bin/sh\nprintf '%s|' "$@" > "${bin}/args"\n`);
    chmodSync(join(bin, "cmd.exe"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    expect(canOpenBrowser()).toBe(true);
    await openBrowser("http://localhost:3000/app#pair=code");
    expect(readFileSync(join(bin, "args"), "utf8")).toBe(
      "/c|start||http://localhost:3000/app#pair=code|",
    );
  });

  it("doesn't open a browser on the remote computer over SSH", () => {
    vi.stubEnv("DISPLAY", ":0");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 34567 192.0.2.2 22");
    expect(canOpenBrowser()).toBe(false);
  });
});
