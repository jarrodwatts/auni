import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { afterAll, describe, expect, inject, it } from "vitest";

import { doorSocket } from "../auth/tailscale.ts";
import { tempDir } from "./temp-dir.ts";

let shared: string;
let passed: string;
let failed: string;

describe("scratch folders", () => {
  shared = tempDir("auni-shared-", afterAll);

  it("can write files during the test", () => {
    passed = tempDir("auni-passed-");
    writeFileSync(join(passed, "fixture"), "test");
  });

  it.fails("can fail after making a folder", () => {
    failed = tempDir("auni-failed-");
    expect(existsSync(failed)).toBe(false);
  });

  it("removes each test's folder and keeps the suite's folder until teardown", () => {
    expect(existsSync(passed)).toBe(false);
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(shared)).toBe(true);
  });
});

it("removes the suite's folder once all its tests finish", () => {
  expect(existsSync(shared)).toBe(false);
});

it("leaves room for the Tailscale socket under a 64-byte temporary path", () => {
  const socket = relative(dirname(inject("tempRoot")), doorSocket());
  expect(64 + 1 + Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
});
