import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { dataDir } from "../data-dir.ts";
import { theBox } from "./box.ts";

const realExecPath = process.execPath;
afterEach(() => {
  Object.defineProperty(process, "execPath", { value: realExecPath });
  vi.unstubAllEnvs();
});

/** Runs as an install does: its Node is the private one in the data folder. */
function installed(): string {
  vi.stubEnv("AUNI_HOME", join(tempDir("auni-box-"), "data"));
  const node = join(dataDir(), "app/node/24.22.2/bin/node");
  mkdirSync(dirname(node), { recursive: true });
  Object.defineProperty(process, "execPath", { value: node });
  return node;
}

describe("the box", () => {
  it("keeps Node's own install readable for the agent's scripts", () => {
    expect(theBox([]).readable).toContain(dirname(dirname(realExecPath)));
  });

  // Codex hides a folder holding something readable entry by entry, from a list taken as the
  // turn starts, which would leave a file made there mid-turn (a new keys file) readable
  // (codex/options.test.ts).
  it("opens nothing in the data folder when Node is an install's, so it stays hidden whole", () => {
    installed();
    const box = theBox([]);
    expect(box.readable.filter((path) => path.startsWith(`${dataDir()}/`))).toEqual([]);
    expect(box.hidden).toContain(dataDir());
  });
});
