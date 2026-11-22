import postgres from "postgres";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** How many db test files run at once, each worker on a database of its own. */
export const DB_WORKERS = 4;

/** Worker `n`'s database: the test database's name with `_<n>` before its `_test`. */
export function workerUrl(url: string, n: number): string {
  const worker = new URL(url);
  worker.pathname = worker.pathname.replace(/_test$/u, `_${n}_test`);
  return worker.href;
}

/**
 * Migrates the test database, then copies it once for each worker, and refuses one that isn't
 * local or isn't named for tests: every test wipes its tables, so a local dev database is off
 * limits too. The copies are made fresh each run, so they always hold this version's schema.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("test:db needs TEST_DATABASE_URL, a local Postgres it may wipe.");
  const { hostname, pathname } = new URL(url);
  if (!LOCAL_HOSTS.has(hostname))
    throw new Error(`test:db only runs against a local Postgres, not ${hostname}.`);
  if (!pathname.endsWith("_test"))
    throw new Error(`test:db only runs against a database named *_test, not ${pathname.slice(1)}.`);
  // Loaded here, not above, so a worker's setup file can read workerUrl without loading src.
  const { migrateDatabase } = await import("../db/migrations.ts");
  await migrateDatabase(url);

  // From the server's own database, as a template can't be copied while anyone is connected to it.
  const admin = postgres(Object.assign(new URL(url), { pathname: "/postgres" }).href, {
    max: 1,
    onnotice: () => {},
  });
  const workers = Array.from({ length: DB_WORKERS }, (_, at) =>
    new URL(workerUrl(url, at + 1)).pathname.slice(1),
  );
  const dropWorkers = async () => {
    for (const name of workers)
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
  };
  await dropWorkers();
  for (const name of workers)
    await admin.unsafe(`create database "${name}" template "${pathname.slice(1)}"`);
  return async () => {
    await dropWorkers();
    await admin.end();
  };
}
