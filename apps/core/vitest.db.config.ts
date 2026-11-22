import { defineConfig } from "vitest/config";

import { DB_WORKERS } from "./src/test/db-global-setup.ts";
import { TEST_TIMEOUT_MS, testEnv } from "./vitest.config.ts";

// The invariants that live in SQL (claims, row locks, conflict keys), run against a real
// Postgres. src/test/db-global-setup.ts refuses anything but a local one, and gives each worker
// a copy of it (src/test/db-worker.ts), so files run side by side.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    maxWorkers: DB_WORKERS,
    globalSetup: ["src/test/db-global-setup.ts"],
    setupFiles: ["src/test/db-worker.ts", "src/test/no-real-keys.ts", "src/test/db-setup.ts"],
    env: testEnv,
    testTimeout: TEST_TIMEOUT_MS,
  },
});
