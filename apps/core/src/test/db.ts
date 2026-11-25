import { CARD_FORMAT } from "@auni/shared";
import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { db } from "../db/client.ts";
import {
  actions,
  arrivalCursors,
  arrivals,
  automations,
  channelLinks,
  owner,
  threads,
  otherTokens,
  valueSnapshots,
} from "../db/schema.ts";

/**
 * What every test starts without: the owner's records, and whatever points at them. Their paired
 * chats are among them, since a worker keeps one database for all its files, and a chat one file
 * paired would otherwise still read as paired in the next.
 */
const OWNERS_RECORDS = [
  threads,
  actions,
  automations,
  valueSnapshots,
  arrivals,
  otherTokens,
  arrivalCursors,
  channelLinks,
];

/**
 * Empties the owner's records and `tables`, and every table pointing at them, and resets the
 * owner's settings, for the next test. The test
 * before may have left a query running: code that threw out of a Promise.all while a sibling
 * query was still going. A truncate locks its tables one by one, so it can deadlock with such a
 * query, and Postgres may break that by failing the truncate, which then goes again.
 */
export async function wipe(...tables: readonly PgTable[]): Promise<void> {
  const names = new Set([...OWNERS_RECORDS, ...tables].map(getTableName));
  const truncate = sql.raw(`truncate ${[...names].join(", ")} cascade`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.execute(truncate);
      break;
    } catch (error) {
      if (attempt === 3 || !deadlocked(error)) throw error;
    }
  }
  await setOwner();
}

function deadlocked(error: unknown): boolean {
  for (let cause = error; cause; cause = (cause as { cause?: unknown }).cause)
    if ((cause as { code?: unknown }).code === "40P01") return true;
  return false;
}

/**
 * Resets the owner's settings to their defaults, as an owner past first run (which tells what
 * arrives before it finishes, see firstRunTells in money/news.ts), then sets `fields`.
 */
export async function setOwner(fields: Partial<typeof owner.$inferInsert> = {}) {
  await db.delete(owner);
  const [row] = await db
    .insert(owner)
    .values({ welcomedAt: new Date("2026-01-01T00:00:00Z"), ...fields })
    .returning();
  return row!;
}

export async function insertThread(fields: Partial<typeof threads.$inferInsert> = {}) {
  const [thread] = await db.insert(threads).values(fields).returning();
  return thread!;
}

/**
 * A move for a test, running unless `fields` say otherwise. A running one that names no phase
 * is queued, or sending once it says when it started; any other phase a test names itself.
 */
export async function insertAction(fields: Partial<typeof actions.$inferInsert> = {}) {
  const status = fields.status ?? "running";
  const phase = fields.phase ?? (fields.startedAt ? "sending" : "queued");
  // A move that is done or failed has ended its run, here as it started unless told otherwise.
  const ended = status === "done" || status === "failed" ? fields.startedAt : undefined;
  const [action] = await db
    .insert(actions)
    .values({
      summary: "Buy about $10 of Nvidia stock",
      amountUsd: "10",
      tool: "stock_trade",
      input: {},
      endedAt: ended,
      // As a money tool records it now (see recordActions).
      cardFormat: CARD_FORMAT,
      ...fields,
      status,
      phase: status === "running" ? phase : null,
    })
    .returning();
  return action!;
}
