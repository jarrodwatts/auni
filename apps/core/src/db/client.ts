import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";
import { ownSession } from "./session.ts";

const client = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});
export const db = drizzle(client, { schema });
export type Database = typeof db;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A session of its own on Auni's database (see ownSession), and queries through it. */
export function openSession(onLost?: () => void): {
  /** Queries on the session: each throws SessionLost once the session is lost. */
  readonly conn: Database;
  close(): Promise<void>;
} {
  const own = ownSession(env.DATABASE_URL, onLost);
  return { conn: drizzle(own, { schema }), close: () => own.end({ timeout: 5 }) };
}

/**
 * Runs `work` holding Postgres's lock on `key`, so anyone else asking for it, in any process,
 * waits until `work` is done. Unlike a transaction's lock it holds across commits: `work` can
 * commit a write and then act on it in the world before the next holder looks. It runs on a
 * session of its own, outside the pool, so waiting ties up no connection a holder needs,
 * and a process that dies takes its lock with it. `work` makes its queries through `conn`, so
 * if the session is lost midway, and the lock with it, its next query throws SessionLost: it
 * never carries on into the next holder's turn.
 */
export async function inTurn<T>(key: string, work: (conn: Database) => Promise<T>): Promise<T> {
  const session = openSession();
  try {
    await session.conn.execute(sql`select pg_advisory_lock(hashtext(${key}))`);
    return await work(session.conn);
  } finally {
    // Closing the session lets go of the lock.
    await session.close();
  }
}

/** Postgres LISTEN, on a connection of its own: the job runner wakes on it (jobs/queue.ts). */
export const notifications = {
  listen: (channel: string, onPayload: (payload: string) => void) =>
    client.listen(channel, onPayload),
};

let files: Promise<string | null> | undefined;

/**
 * Where Postgres keeps its own files, asked once. Run on this machine as the owner (embedded, or
 * Homebrew's on a Mac) they are the owner's to read, raw tables and all, so the agent's box hides
 * them. Null when Postgres won't say, which needs a superuser or pg_read_all_settings.
 */
export function databaseFiles(): Promise<string | null> {
  files ??= client<{ data_directory: string }[]>`show data_directory`.then(
    ([row]) => row?.data_directory ?? null,
    (error: unknown) => {
      console.warn(
        `Postgres won't say where it keeps its files (${error instanceof Error ? error.message : String(error)}), so the agent's box can't hide them if they're on this machine.`,
      );
      return null;
    },
  );
  return files;
}

export async function pingDatabase(): Promise<void> {
  await client`select 1`;
}

export async function closeDatabaseConnection(): Promise<void> {
  await client.end({ timeout: 5 });
}
