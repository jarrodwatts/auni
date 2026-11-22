import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imported first by the live brain scripts (record.ts, brain:escape), before anything reads
// env.ts: a throwaway data folder, so no real wallet key is ever near, and a local test database,
// so nothing real is touched. Never imported by core itself or by a test.

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to a local Postgres database named *_test.");
const { hostname, pathname } = new URL(url);
if (!["localhost", "127.0.0.1"].includes(hostname) || !pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must be a local database named *_test.");

/** The port the live core listens on, clear of a dev core on 4000. */
const LIVE_PORT = 4517;

Object.assign(process.env, {
  DATABASE_URL: url,
  PORT: String(LIVE_PORT),
  HOST: "127.0.0.1",
  WEB_ORIGIN: "http://localhost:3999",
  // The tests' own secret, so cards sealed in a recording still check out when a test replays it.
  TURN_TOKEN_SECRET: "t".repeat(32),
  AUNI_HOME: mkdtempSync(join(tmpdir(), "auni-live-")),
  WALLET: "",
  ELFA_AUTO_API_KEY: "",
});
