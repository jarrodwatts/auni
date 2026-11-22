import { asc, eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { jobs } from "../db/schema.ts";

/** A job as queued: what a test checks it asked for. */
interface Queued {
  readonly kind: string;
  readonly key: string | null;
  readonly data: Record<string, unknown>;
  readonly lanes: string[];
}

/** The jobs queued so far, oldest first; only those of `kind`, when given. */
export async function queued(kind?: string): Promise<Queued[]> {
  const rows = await db
    .select({ kind: jobs.kind, key: jobs.key, data: jobs.data, lanes: jobs.lanes })
    .from(jobs)
    .where(kind ? eq(jobs.kind, kind) : undefined)
    .orderBy(asc(jobs.createdAt), asc(jobs.id));
  return rows.map((row) => ({ ...row, data: row.data as Record<string, unknown> }));
}
