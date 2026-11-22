import { afterAll, beforeEach } from "vitest";

import { closeDatabaseConnection } from "../db/client.ts";
import { firstLooks, jobs } from "../db/schema.ts";
import { setOwner, wipe } from "./db.ts";

// Jobs and first looks point at nothing, so wiping the tables a test uses leaves them; each test
// starts with none, and with the owner's settings at their defaults.
beforeEach(async () => {
  await wipe(jobs, firstLooks);
  await setOwner();
});
afterAll(() => closeDatabaseConnection());
