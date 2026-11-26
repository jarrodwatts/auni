import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";

import { expect, it } from "vitest";

import { tempDir } from "../test/temp-dir.ts";

it.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("clears the live scratch directory on %s", async (signal, code) => {
  const scratch = tempDir("live-env-test-");
  const liveEnv = new URL("./live-env.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import ${JSON.stringify(liveEnv)};
       import { writeFileSync } from "node:fs";
       writeFileSync(process.env.AUNI_HOME + "/fixture", "test");
       setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 0);
       setTimeout(() => process.exit(1), 2_000);`,
    ],
    {
      env: {
        TMPDIR: scratch,
        TEST_DATABASE_URL: "postgres://nobody@127.0.0.1:1/live_test",
      },
      stdio: "ignore",
    },
  );
  expect(await once(child, "exit")).toEqual([code, null]);
  expect(readdirSync(scratch).filter((name) => name.startsWith("auni-live-"))).toEqual([]);
});
