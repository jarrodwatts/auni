import { existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appDir,
  BUILT,
  currentTag,
  installed,
  listVersions,
  selfCommand,
  switchCurrent,
  versionDir,
} from "./layout.ts";

beforeEach(() => vi.stubEnv("AUNI_HOME", mkdtempSync(join(tmpdir(), "auni-layout-"))));
afterEach(() => vi.unstubAllEnvs());

function version(tag: string, built = true): string {
  mkdirSync(versionDir(tag), { recursive: true });
  if (built) writeFileSync(join(versionDir(tag), BUILT), "");
  return versionDir(tag);
}

describe("the install layout", () => {
  it("switches current in one step, leaving no current.new behind", () => {
    version("v0.1.0");
    version("v0.1.1");
    switchCurrent("v0.1.0");
    switchCurrent("v0.1.1");
    expect(currentTag()).toBe("v0.1.1");
    expect(readlinkSync(join(appDir(), "current"))).toBe(join("versions", "v0.1.1"));
    expect(existsSync(join(appDir(), "current.new"))).toBe(false);
  });

  it("has no current before anything is installed", () => {
    expect(currentTag()).toBeNull();
    expect(listVersions()).toEqual([]);
  });

  it("lists only versions built in full, oldest first", () => {
    version("v0.10.0");
    version("v0.9.3");
    version("v0.11.0", false);
    expect(listVersions()).toEqual(["v0.9.3", "v0.10.0"]);
  });

  it("runs an install through its launcher, which always runs current", () => {
    const root = version("v0.1.0");
    expect(installed(root)).toBe(true);
    expect(selfCommand(root)).toEqual([join(appDir(), "bin", "auni")]);
  });

  it("runs a checkout through its own entry, on this Node", () => {
    const root = mkdtempSync(join(tmpdir(), "auni-checkout-"));
    expect(installed(root)).toBe(false);
    expect(selfCommand(root)).toEqual([process.execPath, join(root, "apps/core/bin/auni.mjs")]);
    // This test runs from the repo, a checkout.
    expect(installed()).toBe(false);
  });
});
