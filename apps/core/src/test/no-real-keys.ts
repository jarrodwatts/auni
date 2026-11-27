import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, vi } from "vitest";

import { tempDir } from "./temp-dir.ts";

// Each file gets its own home and temp folder inside the run's scratch root, so tests and any
// children they spawn never reach ~/.auni or leave folders behind in the caller's TMPDIR.
// Auni creates work and tools folders beside its home, and Tailscale tests bind a Unix socket
// inside it, so keep the folder names short.
const scratch = tempDir("", afterAll);
process.env.AUNI_HOME = join(scratch, "h");
const tmp = join(scratch, "t");
mkdirSync(tmp);
process.env.TMPDIR = tmp;
if (process.platform === "win32") {
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
}

// The OS keychain outlives every test, so reaching it fails the test that did, even where the
// keys would have gone to a file once it refused (as every caller of a keychain that isn't
// there does). A test of the keychain stands in an entry of its own.
const reached = vi.hoisted(() => [] as string[]);
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(service: string, account: string) {
      reached.push(`${service}/${account}`);
      throw new Error("No test may reach the OS keychain.");
    }
  },
}));
afterEach(() => {
  const entries = reached.splice(0);
  if (entries.length > 0)
    throw new Error(`This test reached the OS keychain, for ${entries.join(", ")}.`);
});
