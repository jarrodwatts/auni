import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { dataDir } from "../data-dir.ts";
import { env } from "../env.ts";
import { insertAction, insertThread } from "../test/db.ts";
import { db } from "./client.ts";
import { ExportRefused, exportDatabase, importDatabase } from "./export.ts";
import { migrateDatabase } from "./migrations.ts";
import { fills, messages } from "./schema.ts";

// An export loaded into a database Auni never used must hold, row for row and to the last
// digit, what the database it was written from holds.

const scratch = tempDir("auni-export-test-", afterAll);
const file = join(scratch, "auni.jsonl.gz");
const admin = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
/** An empty database beside this worker's, for the import. */
const emptyName = `${new URL(env.DATABASE_URL).pathname.slice(1)}_import`;
const emptyUrl = (() => {
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${emptyName}`;
  return url.toString();
})();

async function fresh(): Promise<void> {
  await admin.unsafe(`drop database if exists "${emptyName}" with (force)`);
  await admin.unsafe(`create database "${emptyName}"`);
}

/** Every row of every table, as Postgres writes it, in a fixed order. */
async function everything(url: string): Promise<Record<string, string[]>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ name: string }[]>`
      select table_name as name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    const held: Record<string, string[]> = {};
    for (const { name } of tables) {
      const rows = await sql<{ row: string }[]>`
        select row_to_json(t)::text as row from ${sql(name)} t order by 1`;
      held[name] = rows.map(({ row }) => row);
    }
    return held;
  } finally {
    await sql.end();
  }
}

beforeAll(fresh);
afterAll(async () => {
  await admin.unsafe(`drop database if exists "${emptyName}" with (force)`);
  await admin.end();
});

describe("an export", () => {
  it("loads into an empty database as exactly what was kept, routines and all", async () => {
    const thread = await insertThread({
      title: "Nuclear",
      budgetUsd: "1234.56",
      expectedTokens: ["base:0xabc"],
    });
    const [first] = await db
      .insert(messages)
      .values({
        threadId: thread.id,
        role: "user",
        parts: [{ type: "text", text: 'Buy "some"\n' }],
      })
      .returning();
    // A message that points at another in its own table.
    await db.insert(messages).values({
      threadId: thread.id,
      role: "user",
      parts: [{ type: "text", text: "Buy more" }],
      supersedesId: first!.id,
    });
    const action = await insertAction({ threadId: thread.id });
    // More digits than a JavaScript number keeps.
    await db.insert(fills).values({
      actionId: action.id,
      threadId: thread.id,
      instrument: "native",
      chain: "solana",
      side: "buy",
      quantity: "12345678901234567890.123456789012345678",
      usdValue: "10.00",
    });
    const routine = join(dataDir(), "routines/check-rates/SKILL.md");
    mkdirSync(join(dataDir(), "routines/check-rates"), { recursive: true });
    writeFileSync(routine, "---\nname: check-rates\n---\nLook at the rates.\n");

    const written = await exportDatabase(env.DATABASE_URL, file, "9.9.9");
    expect(written.files).toBe(1);
    rmSync(join(dataDir(), "routines"), { recursive: true });
    const loaded = await importDatabase(emptyUrl, file);

    expect(loaded).toEqual({ rows: written.rows, files: 1, from: "9.9.9" });
    const [before, after] = await Promise.all([everything(env.DATABASE_URL), everything(emptyUrl)]);
    expect(after).toEqual(before);
    expect(before.fills?.[0]).toContain("12345678901234567890.123456789012345678");
    expect(readFileSync(routine, "utf8")).toContain("Look at the rates.");
    // The next start finds nothing to do: it is this version's database, whole.
    await migrateDatabase(emptyUrl);
    expect(await everything(emptyUrl)).toEqual(before);
    // Identity sequences advance past imported values so new rows keep increasing.
    const imported = postgres(emptyUrl, { max: 1, onnotice: () => {} });
    try {
      const [next] = await imported<{ seq: string }[]>`
        insert into actions (thread_id, summary, amount_usd, status, tool, input)
        values (${thread.id}, 'After import', 1.00, 'awaiting_permission', 'buy_token', '{}')
        returning seq::text`;
      expect(Number(next!.seq)).toBeGreaterThan(action.seq);
    } finally {
      await imported.end();
    }
  });

  it("never writes over a database Auni has used", async () => {
    await exportDatabase(env.DATABASE_URL, file, "9.9.9");
    await expect(importDatabase(env.DATABASE_URL, file)).rejects.toThrow(ExportRefused);
    await expect(importDatabase(env.DATABASE_URL, file)).rejects.toThrow(/used already/u);
  });

  it("leaves the database unused when the file can't be loaded whole", async () => {
    await fresh();
    await insertThread();
    await exportDatabase(env.DATABASE_URL, file, "9.9.9");
    const lines = gunzipSync(readFileSync(file)).toString().split("\n");
    // A row for a table this version doesn't have.
    lines.splice(1, 0, '{"table":"no_such_table","row":{"id":1}}');
    const broken = join(scratch, "broken.jsonl.gz");
    writeFileSync(broken, gzipSync(lines.join("\n")));

    await expect(importDatabase(emptyUrl, broken)).rejects.toThrow();
    // So the same database takes the good file after.
    await expect(importDatabase(emptyUrl, file)).resolves.toMatchObject({ from: "9.9.9" });
  });

  it("refuses a file Auni didn't write, and one from a schema this version doesn't know", async () => {
    await fresh();
    const notOurs = join(scratch, "other.gz");
    writeFileSync(notOurs, gzipSync('{"hello":"there"}\n'));
    await expect(importDatabase(emptyUrl, notOurs)).rejects.toThrow(/isn't an export/u);
    const newer = join(scratch, "newer.gz");
    writeFileSync(
      newer,
      gzipSync(
        `${JSON.stringify({ auni: "export", version: "99.0.0", schema: 9_999_999_999_999, at: "" })}\n`,
      ),
    );
    await expect(importDatabase(emptyUrl, newer)).rejects.toThrow(/newer Auni/u);
  });
});
