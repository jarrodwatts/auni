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
  let active: { cancel(): void } | null = null;
  let forceEnd: ReturnType<typeof setTimeout> | undefined;
  // Track every query on this session (including inside Drizzle's migration transaction) so a stop
  // sends Postgres's cancel request for whatever is in flight (advisory lock wait or blocked DDL),
  // letting the transaction roll back and release its locks before closing the connection.
  const track = <T>(query: T): T => {
    if (
      query &&
      typeof query === "object" &&
      "cancel" in query &&
      typeof query.cancel === "function" &&
      "then" in query &&
      typeof query.then === "function"
    ) {
      const pending = query as { cancel(): void; then: Promise<unknown>["then"] };
      active = pending;
      const clear = () => {
        if (active === pending) active = null;
      };
      void pending.then(clear, clear);
    }
    return query;
  };
  const wrap = (session: Sql): Sql =>
    new Proxy(session, {
      apply: (target, self, args) => {
        signal?.throwIfAborted();
        return track(Reflect.apply(target, self, args) as unknown);
      },
      get: (target, key) => {
        if (key === "unsafe") {
          return (...args: unknown[]) => {
            signal?.throwIfAborted();
            return track(
              Reflect.apply(target.unsafe as (...a: unknown[]) => unknown, target, args),
            );
          };
        }
        if (key === "begin") {
          return (...args: unknown[]) => {
            signal?.throwIfAborted();
            const fnIndex = typeof args[0] === "function" ? 0 : 1;
            const fn = args[fnIndex] as (tx: Sql) => unknown;
            const next = [...args];
            next[fnIndex] = (tx: Sql) => fn(wrap(tx));
            return Reflect.apply(target.begin as (...a: unknown[]) => unknown, target, next);
          };
        }
        return Reflect.get(target, key) as unknown;
      },
    });
  const abort = () => {
    active?.cancel();
    // Fallback if Postgres doesn't answer the cancel request (e.g. unreachable network).
    forceEnd = setTimeout(() => void client.end({ timeout: 0 }), 500);
    forceEnd.unref();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const tracked = signal ? wrap(client) : client;
    await tracked`select pg_advisory_lock(hashtext('auni:migrate'))`;
    signal?.throwIfAborted();
    await migrate(drizzle(tracked), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(forceEnd);
    // Closing the session lets go of the lock; once aborted, close promptly rather than waiting
    // on a half-open connect or hung server.
    await client.end(signal?.aborted ? { timeout: 0 } : undefined);
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
