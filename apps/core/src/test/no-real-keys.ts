import { join } from "node:path";

import { afterAll, afterEach, vi } from "vitest";

import { tempDir } from "./temp-dir.ts";

// Each file gets its own home, so tests and children spawned by them never reach ~/.auni.
// Auni creates work and tools folders beside its home. Keep all three inside the scratch folder.
// The Tailscale tests bind a Unix socket here, so keep both names short.
process.env.AUNI_HOME = join(tempDir("", afterAll), "h");

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
