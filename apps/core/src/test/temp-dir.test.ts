import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

it("makes every scratch folder inside the run's root, even with no prefix", () => {
  const root = inject("tempRoot");
  for (const dir of [tempDir(""), tempDir("x-"), dirname(doorSocket()), tmpdir()])
    expect(relative(root, dir).startsWith("..")).toBe(false);
  expect(existsSync(tmpdir())).toBe(true);
});

it("leaves room for the Tailscale socket under a 64-byte temporary path", () => {
  const socket = relative(dirname(inject("tempRoot")), doorSocket());
  expect(64 + 1 + Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
});
