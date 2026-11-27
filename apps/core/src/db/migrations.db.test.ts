import { setTimeout as sleep } from "node:timers/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateDatabase, MIGRATIONS_FOLDER, pendingMigrations } from "./migrations.ts";

// Each case on a database of its own, beside the test database, made empty and dropped after.
const server = new URL(process.env.TEST_DATABASE_URL!);
const name = `${server.pathname.slice(1)}_migrations`;
const url = Object.assign(new URL(server), { pathname: `/${name}` }).href;
const admin = postgres(server.href, { max: 1, onnotice: () => {} });

async function emptyDatabase() {
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
}

beforeAll(emptyDatabase);
afterAll(async () => {
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.end();
});

describe("migrations", () => {
  it("brings an empty database to this version, and then has nothing to apply", async () => {
    await emptyDatabase();
    const all = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length;
    expect(await pendingMigrations(url)).toBe(all);
    await migrateDatabase(url);
    expect(await pendingMigrations(url)).toBe(0);
    // Twice is fine.
    await migrateDatabase(url);
    // The owner's settings are one row, at their defaults, and only ever one.
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      expect(await client`select id, name, time_zone, brief from owner`).toEqual([
        { id: 1, name: null, time_zone: "UTC", brief: { every: "day", at: "08:00" } },
      ]);
      await expect(client`insert into owner (id) values (2)`).rejects.toThrow(/owner_one_row/u);
    } finally {
      await client.end();
    }
  });

  it("cancels waiting on another session's migration lock when its signal aborts", async () => {
    const holder = postgres(url, { max: 1, onnotice: () => {} });
    const abort = new AbortController();
    try {
      await holder`select pg_advisory_lock(hashtext('auni:migrate'))`;
      const waiting = migrateDatabase(url, abort.signal);
      // Wait until the migration session is actually blocked on the advisory lock.
      let blocked = false;
      for (let i = 0; i < 40; i++) {
        const rows = await holder<{ pid: number }[]>`
          select pid from pg_stat_activity
          where datname = ${name} and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        if (rows.length > 0) {
          blocked = true;
          break;
        }
        await sleep(25);
      }
      expect(blocked).toBe(true);

      const started = performance.now();
      abort.abort();
      await expect(waiting).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(2_000);

      // The cancelled wait doesn't linger in Postgres either.
      let remaining = 1;
      for (let i = 0; i < 40; i++) {
        const rows = await holder<{ pid: number }[]>`
          select pid from pg_stat_activity
          where datname = ${name} and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        remaining = rows.length;
        if (remaining === 0) break;
        await sleep(25);
      }
      expect(remaining).toBe(0);
    } finally {
      await holder.end();
    }
  });
});
