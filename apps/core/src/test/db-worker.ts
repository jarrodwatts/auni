import { workerUrl } from "./db-global-setup.ts";

// The first setup file of each db test worker: points it at its own copy of the test database
// (db-global-setup.ts) before anything reads DATABASE_URL, so files running at once never wipe
// each other's rows. A child a test spawns (a runner, in jobs/faults.db.test.ts) inherits it.
process.env.DATABASE_URL = workerUrl(
  process.env.TEST_DATABASE_URL!,
  Number(process.env.VITEST_POOL_ID),
);
