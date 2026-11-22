import { NETWORK_KEYS } from "@auni/shared";
import { defineConfig } from "vitest/config";

// Enough config for env.ts to parse; vitest.db.config.ts reuses it with a real database. The
// blanks read as unset, so a key exported in the shell never reaches a test.
export const testEnv = {
  WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://localhost:5432/unused",
  PRIVY_APP_ID: "test",
  PRIVY_APP_SECRET: "test",
  PRIVY_AUTHORIZATION_KEY: "test",
  WALLET: "",
  BRAIN: "",
  AUNI_ANTHROPIC_API_KEY: "",
  // The data folder is each worker's own, set in src/test/no-real-keys.ts.
  ALCHEMY_API_KEY: "test",
  ...Object.fromEntries(NETWORK_KEYS.map((chain) => [`RPC_URL_${chain.toUpperCase()}`, ""])),
  TURN_TOKEN_SECRET: "t".repeat(32),
  HOST: "",
  TAILSCALE_OWNER: "",
  ELFA_AUTO_API_KEY: "",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_API_URL: "",
  JUPITER_API_KEY: "",
  RELAY_API_KEY: "",
  POLYMARKET_BUILDER_API_KEY: "",
  POLYMARKET_BUILDER_SECRET: "",
  POLYMARKET_BUILDER_PASSPHRASE: "",
};

/**
 * How long a test may take. Code that reaches the app registry imports it when first asked
 * (money/pay-in.ts, token-feeds.ts, settings.ts), so the first test in a file that does pays for
 * loading every app, and a database test may load or export a whole database: seconds on an idle
 * machine, past vitest's 5s on a busy one.
 */
export const TEST_TIMEOUT_MS = 20_000;

// No test here opens a database connection; *.db.test.ts run under `test:db`.
const EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/*.db.test.ts"];
/** The one test that writes into src: it scaffolds apps beside the real ones, then removes them. */
const WRITES_SRC = "src/apps/scaffold.test.ts";

export default defineConfig({
  test: {
    env: testEnv,
    setupFiles: ["src/test/no-real-keys.ts"],
    testTimeout: TEST_TIMEOUT_MS,
    // Tests that read src as a tree (held-to-card.test.ts, apps.test.ts) would see its
    // folders come and go, so it runs alone, once every other test has finished.
    projects: [
      { extends: true, test: { name: "core", exclude: [...EXCLUDE, WRITES_SRC] } },
      {
        extends: true,
        test: { name: "writes-src", include: [WRITES_SRC], sequence: { groupOrder: 1 } },
      },
    ],
  },
});
