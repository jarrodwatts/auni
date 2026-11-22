import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canOpenBrowser, openBrowser } from "./open-browser.ts";

describe.runIf(process.platform === "linux")("openBrowser", () => {
  const bins: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const bin of bins.splice(0)) rmSync(bin, { recursive: true, force: true });
  });
  /** An xdg-open stand-in that exits with `code`. */
  function opener(code: number) {
    const bin = mkdtempSync(join(tmpdir(), "auni-opener-"));
    bins.push(bin);
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
    const bin = mkdtempSync(join(tmpdir(), "auni-opener-"));
    bins.push(bin);
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
});
