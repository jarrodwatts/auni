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
});
