import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, vi } from "vitest";

// No test may touch the owner's real wallet keys. Each worker gets a scratch data folder of its
// own, never ~/.auni, set here inside the worker so files running at once never share one (two
// saving the same routine would overwrite each other's file). A child a test spawns inherits it,
// and a data folder other than ~/.auni keeps its keys in its own file (machineKeyStore).
process.env.AUNI_HOME = join(
  tmpdir(),
  `auni-test-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`,
);

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
