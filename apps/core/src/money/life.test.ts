import path from "node:path";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// A move's state changes only in life.ts. ESLint holds that (eslint.config.mjs): these lint a
// write to the actions table as if it sat in another of core's files.

const ROOT = path.resolve(import.meta.dirname, "../../../..");
// Without type information, which this rule doesn't need and which takes a minute to load.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: {
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
});

/** How many writes of a move's state ESLint refuses in `source`, as one of core's own files. */
async function refused(source: string, file = "money/elsewhere.ts"): Promise<number> {
  const [report] = await eslint.lintText(
    `declare const db: any, actions: any, schema: any, sql: any, row: any, begins: any;\n${source}`,
    {
      filePath: path.join(ROOT, "apps/core/src", file),
    },
  );
  return report!.messages.filter((message) => message.message.includes("money/life.ts")).length;
}

describe("a move's state", () => {
  beforeAll(() => refused(""), 120_000);

  it("can't be written by an update anywhere but life.ts, nor can the card's details", async () => {
    for (const key of ["status", "phase", "startedAt", "details"])
      expect(await refused(`db.update(actions).set({ ${key}: null }).where(true);`)).toBe(1);
    expect(await refused(`db.update(actions).set({ error: null, run: {} });`)).toBe(0);
    // Another table's status is its own.
    expect(await refused(`db.update(specialists).set({ status: "retired" });`)).toBe(0);
  });

  it("can't be written by an update spelled any other way", async () => {
    for (const write of [
      // The columns held in a variable, spread from one, or named by a computed key.
      `db.update(actions).set(row);`,
      `db.update(actions).set({ ...row, error: null });`,
      `db.update(actions).set({ ["status"]: "done" });`,
      `db.update(actions).set({ "phase": null });`,
      // The table named through the schema, or the write kept in a variable.
      `db.update(schema.actions).set({ status: "done" });`,
      `const write = db.update(actions);`,
      // SQL text, with the table named or interpolated.
      "db.execute(sql`update actions set status = 'done'`);",
      "db.execute(sql`UPDATE ${actions} SET status = 'done'`);",
      `db.execute(sql.raw('insert into "actions" (status) values (1)'));`,
      // An insert that updates the row it meets.
      `db.insert(actions).values({ ...begins("done") }).onConflictDoUpdate({ target: actions.id, set: { status: "done" } });`,
    ])
      expect(await refused(write), write).toBeGreaterThan(0);
    // Reads of the table, and SQL that names a column of it, are not writes.
    expect(
      await refused("db.execute(sql`select 1 from ${actions} where ${actions.status} = 'done'`);"),
    ).toBe(0);
    expect(await refused(`db.update(actions).set({ txs: sql\`\${actions.txs} || '[]'\` });`)).toBe(
      0,
    );
  });

  it("can't be written by an insert, which starts a row with begins()", async () => {
    const insert = (row: string) => `db.insert(actions).values(${row});`;
    expect(await refused(insert(`{ status: "running", phase: "queued" }`))).toBe(2);
    expect(await refused(insert(`[1].map(() => ({ status: "done" }))`))).toBe(1);
    expect(await refused(insert(`{ ...begins("queued"), details: {} }`))).toBe(0);
    expect(await refused(insert(`[1].map(() => ({ ...begins("queued") }))`))).toBe(0);
    expect(await refused(insert(`row`))).toBe(1);
    expect(await refused(insert(`{ ...row }`))).toBe(1);
  });

  it("is a test's to set up as it likes", async () => {
    const write = `db.update(actions).set({ status: "done", phase: null });`;
    expect(await refused(write, "money/some.db.test.ts")).toBe(0);
    expect(await refused(write, "test/db.ts")).toBe(0);
  });
});
