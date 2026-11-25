import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { expect, it } from "vitest";

import { env } from "./env.ts";

it("tells the owner to start Auni when pairing before the first startup", async () => {
  const url = new URL(env.DATABASE_URL);
  const name = `${url.pathname.slice(1)}_pair`;
  const admin = postgres(url.href, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  url.pathname = `/${name}`;
  try {
    await expect(
      promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("../bin/auni.mjs", import.meta.url)), "pair"],
        {
          env: { ...process.env, DATABASE_URL: url.href },
        },
      ),
    ).rejects.toMatchObject({ code: 1, stdout: "", stderr: "Start Auni first: run pnpm auni\n" });
  } finally {
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.end();
  }
});
