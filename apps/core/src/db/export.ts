import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createGunzip, createGzip } from "node:zlib";

import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { dataDir } from "../data-dir.ts";
import { MIGRATIONS_FOLDER } from "./migrations.ts";

// A way out of the database that needs no tool but Auni itself: `auni export` writes every row
// Auni keeps, and the owner's routines, to one file, and `auni import` loads that file into a
// database Auni has never used. The file is gzipped lines of JSON, readable anywhere:
//
//   {"auni":"export","version":"0.1.0","schema":1762000000000,"at":"2026-11-11T..."}   first
//   {"table":"threads","row":{...}}                                                    a row
//   {"file":"routines/check-rates/SKILL.md","text":"..."}                              a routine
//
// Each row is the JSON Postgres itself writes for it and reads back, so a number too long for
// JavaScript, a timestamp or an array comes back exactly as it was kept. `schema` is the newest
// migration the database had; an import builds the tables as of that migration, loads the rows,
// and the next start brings them up to date like any other database.
//
// Not in the file, on purpose: the wallet's keys (the OS keychain, or wallet-keys.json in the
// data folder) and the owner's settings (.env). Those are theirs to carry over by hand.

/** The owner's files an export carries: their routines (agent/routines.ts), under the data folder. */
const KEPT_FOLDERS = ["routines"];

interface Header {
  readonly auni: "export";
  /** The Auni that wrote it. */
  readonly version: string;
  /** The `when` of the newest migration the database had (drizzle's ledger). */
  readonly schema: number;
  readonly at: string;
}

/** The export couldn't be made or loaded; its message is for the owner. */
export class ExportRefused extends Error {}

const connect = (url: string) => postgres(url, { max: 1, onnotice: () => {} });

/** A connection, or a transaction on one. */
type Queries = Sql | TransactionSql;

/** Every table Auni keeps, by name. */
async function tablesOf(sql: Queries): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
  return rows.map(({ name }) => name);
}

/** The newest migration the database has had, or null for one Auni never migrated. */
async function schemaOf(sql: Queries): Promise<number | null> {
  const [ledger] = await sql<{ exists: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  if (!ledger?.exists) return null;
  const [last] = await sql<{ at: string | null }[]>`
    select max(created_at)::text as at from drizzle.__drizzle_migrations`;
  return last?.at ? Number(last.at) : null;
}

/** Every file under `folder`, relative to it. */
async function filesIn(folder: string, under = ""): Promise<string[]> {
  if (!existsSync(join(folder, under))) return [];
  const entries = await readdir(join(folder, under), { withFileTypes: true });
  const found = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesIn(folder, join(under, entry.name))
        : entry.isFile()
          ? [join(under, entry.name)]
          : [],
    ),
  );
  return found.flat();
}

/**
 * Writes everything in the database at `url`, and the owner's routines, to `file`. It reads
 * one moment of the database, so it is whole even while Auni runs.
 */
export async function exportDatabase(
  url: string,
  file: string,
  version: string,
): Promise<{ readonly rows: number; readonly files: number }> {
  const sql = connect(url);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const gzip = createGzip();
  const out = gzip.pipe(createWriteStream(file, { mode: 0o600 }));
  const write = async (line: string) => {
    if (!gzip.write(`${line}\n`)) await once(gzip, "drain");
  };
  let rows = 0;
  try {
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      const schema = await schemaOf(tx);
      if (schema === null)
        throw new ExportRefused(
          "This database holds nothing of Auni's yet, so there is nothing to export.",
        );
      const header: Header = { auni: "export", version, schema, at: new Date().toISOString() };
      await write(JSON.stringify(header));
      for (const table of await tablesOf(tx)) {
        const name = JSON.stringify(table);
        // Postgres writes each row's JSON, and its text goes to the file as it is.
        const batches = tx<{ row: string }[]>`
          select row_to_json(t)::text as row from ${tx(table)} t`.cursor(500);
        for await (const batch of batches) {
          for (const { row } of batch) await write(`{"table":${name},"row":${row}}`);
          rows += batch.length;
        }
      }
    });
    const files = (
      await Promise.all(
        KEPT_FOLDERS.map(async (folder) =>
          (await filesIn(join(dataDir(), folder))).map((path) => join(folder, path)),
        ),
      )
    ).flat();
    for (const path of files)
      await write(
        JSON.stringify({ file: path, text: await readFile(join(dataDir(), path), "utf8") }),
      );
    gzip.end();
    await once(out, "finish");
    return { rows, files: files.length };
  } catch (error) {
    gzip.destroy();
    await rm(file, { force: true });
    throw error;
  } finally {
    await sql.end();
  }
}

/** The export's lines, one at a time. */
async function* linesOf(file: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
  for await (const line of lines) if (line) yield line;
}

/**
 * This version's migrations up to and including `schema`, as a folder drizzle can apply: the
 * tables as they were when the export was written.
 */
async function migrationsUpTo(schema: number): Promise<string> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
  ) as { entries: { when: number; tag: string }[] };
  const entries = journal.entries.filter(({ when }) => when <= schema);
  if (!entries.some(({ when }) => when === schema))
    throw new ExportRefused(
      "This export was written by a newer Auni than this one, or one whose database this " +
        "version can't read. Import it with the version that wrote it, or a newer one.",
    );
  const folder = mkdtempSync(join(tmpdir(), "auni-import-"));
  await mkdir(join(folder, "meta"));
  await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries)
    await cp(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  // Fails here, rather than midway, if drizzle can't read what was written.
  readMigrationFiles({ migrationsFolder: folder });
  return folder;
}

/** Whether Auni has never used the database at `url`, so an import may load into it. */
export async function databaseUnused(url: string): Promise<boolean> {
  const sql = connect(url);
  try {
    return (await schemaOf(sql)) === null && (await tablesOf(sql)).length === 0;
  } finally {
    await sql.end();
  }
}

/** The export's first line, read from its `lines`: which Auni wrote it, and its schema. */
async function headerOf(lines: AsyncGenerator<string>, file: string): Promise<Header> {
  const first = await lines.next().catch(() => ({ done: true as const, value: undefined }));
  const header = first.done ? null : (JSON.parse(first.value) as Partial<Header>);
  if (header?.auni !== "export" || typeof header.schema !== "number")
    throw new ExportRefused(`${file} isn't an export Auni wrote.`);
  return header as Header;
}

/** Throws ExportRefused, as an import would before touching anything, for one this Auni can't load. */
export async function checkExport(file: string): Promise<void> {
  const lines = linesOf(file);
  try {
    const { schema } = await headerOf(lines, file);
    await rm(await migrationsUpTo(schema), { recursive: true, force: true });
  } finally {
    await lines.return(undefined);
  }
}

/**
 * Loads the export at `file` into the database at `url`, which Auni must never have used, and
 * puts the owner's routines back in the data folder. All of it or none: a file that can't be
 * loaded whole leaves the database as empty as it was.
 */
export async function importDatabase(
  url: string,
  file: string,
): Promise<{ readonly rows: number; readonly files: number; readonly from: string }> {
  const lines = linesOf(file);
  const header = await headerOf(lines, file);
  const migrations = await migrationsUpTo(header.schema);
  const sql = connect(url);
  try {
    if (!(await databaseUnused(url)))
      throw new ExportRefused(
        "This database has been used already, and an import never writes over one. Import into " +
          "a new one: a new AUNI_HOME, or a DATABASE_URL naming an empty database.",
      );
    await migrate(drizzle(sql), { migrationsFolder: migrations });
    let rows = 0;
    const files: { file: string; text: string }[] = [];
    await sql.begin(async (tx) => {
      // The migrations make a few rows of their own (the owner's settings), which the export holds too.
      for (const table of await tablesOf(tx)) await tx`delete from ${tx(table)}`;
      // Rows arrive table by table, in no order a reference would need, so the references
      // between tables are checked once everything is in.
      const references = await tx<{ table: string; name: string; definition: string }[]>`
        select conrelid::regclass::text as "table", conname as name,
               pg_get_constraintdef(oid) as definition
        from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`;
      for (const { table, name } of references)
        await tx.unsafe(`alter table ${table} drop constraint "${name}"`);
      for await (const line of lines) {
        const parsed = JSON.parse(line) as { table?: string; file?: string; text?: string };
        if (parsed.file !== undefined) {
          files.push({ file: parsed.file, text: parsed.text ?? "" });
          continue;
        }
        if (!parsed.table) continue;
        // The row's own text, not the parsed copy: Postgres reads its numbers exactly.
        const row = line.slice(line.indexOf('"row":') + '"row":'.length, -1);
        await tx`
          insert into ${tx(parsed.table)}
          select * from json_populate_record(null::${tx(parsed.table)}, ${row}::json)`;
        rows += 1;
      }
      for (const { table, name, definition } of references)
        await tx.unsafe(`alter table ${table} add constraint "${name}" ${definition}`);
    });
    for (const { file: path, text } of files) {
      // Only into the folders an export carries, wherever its lines say.
      if (!KEPT_FOLDERS.some((folder) => path.startsWith(`${folder}/`)) || path.includes(".."))
        continue;
      await mkdir(dirname(join(dataDir(), path)), { recursive: true, mode: 0o700 });
      await writeFile(join(dataDir(), path), text, { mode: 0o600 });
    }
    return { rows, files: files.length, from: header.version ?? "an unknown version" };
  } catch (error) {
    // Nothing of a failed import stays: the database is as unused as it was found.
    if (!(error instanceof ExportRefused))
      await sql.unsafe(
        "drop schema if exists drizzle cascade; drop schema public cascade; create schema public",
      );
    throw error;
  } finally {
    await sql.end();
    await rm(migrations, { recursive: true, force: true });
  }
}
