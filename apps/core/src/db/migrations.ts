import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

import { ownSession } from "./session.ts";

/** The migrations this version carries. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** The times (each migration's `when`) of what the database at `client` has had, oldest first. */
async function applied(client: Sql): Promise<number[]> {
  const [ledger] = await client<{ exists: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  if (!ledger?.exists) return [];
  const rows = await client<{ at: string }[]>`
    select created_at::text as at from drizzle.__drizzle_migrations order by created_at`;
  return rows.map(({ at }) => Number(at));
}

/** This version's migrations the database hasn't had. */
async function pending(client: Sql) {
  const since = (await applied(client)).at(-1) ?? 0;
  return readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).filter(
    ({ folderMillis }) => folderMillis > since,
  );
}

/**
 * Brings the database at `url` to this version's schema, as `auni` does before anything
 * else touches it. Two starting at once on one database take turns.
 */
export async function migrateDatabase(url: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const client = ownSession(url);
  let waiting: { cancel(): void } | null = null;
  let forceEnd: ReturnType<typeof setTimeout> | undefined;
  // A stop asked while waiting on the lock sends Postgres's cancel request (falling back to
  // closing the socket if Postgres doesn't answer), so the backend leaves the wait cleanly;
  // during a migration it closes the session so the transaction rolls back whole.
  const abort = () => {
    if (waiting) {
      waiting.cancel();
      forceEnd = setTimeout(() => void client.end({ timeout: 0 }), 500);
      forceEnd.unref();
    } else void client.end({ timeout: 0 });
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const lock = client`select pg_advisory_lock(hashtext('auni:migrate'))`;
    waiting = lock;
    await lock;
    waiting = null;
    signal?.throwIfAborted();
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(forceEnd);
    // Closing the session lets go of the lock.
    await client.end(signal?.aborted ? { timeout: 1 } : undefined);
  }
}

/** How many of this version's migrations the database at `url` hasn't had yet. */
export async function pendingMigrations(url: string): Promise<number> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return (await pending(client)).length;
  } finally {
    await client.end();
  }
}
