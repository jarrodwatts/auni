import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { jobs, valueSnapshots } from "../db/schema.ts";
import { hasWallet } from "../money/wallets.ts";
import { wipe } from "../test/db.ts";
import { readingBackstopJob, readingOverdue } from "./readings.ts";

vi.mock("../money/wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasWallet: vi.fn(async () => true),
}));

beforeEach(() => wipe(valueSnapshots));

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000);
const job = { id: "reading-backstop", createdAt: new Date(), attempts: 1, signal: new AbortController().signal };

async function readingAt(hours: number) {
  await db.insert(valueSnapshots).values({ usdValue: "10.00", takenAt: hoursAgo(hours) });
}

describe("readingOverdue", () => {
  it("is overdue with no reading of the total, or none in 20 hours", async () => {
    expect(await readingOverdue()).toBe(true);
    await readingAt(25);
    expect(await readingOverdue()).toBe(true);
    await readingAt(2);
    expect(await readingOverdue()).toBe(false);
  });
});

describe("readingBackstopJob", () => {
  const asked = () => db.select().from(jobs).where(eq(jobs.kind, "reading"));

  it("asks for none before the wallet has keys, so reading makes none", async () => {
    vi.mocked(hasWallet).mockResolvedValueOnce(false);
    await readingBackstopJob.run({}, job);
    expect(await asked()).toEqual([]);
  });

  it("asks for one once the last reading is 20 hours old, and none while it is fresh", async () => {
    await readingAt(2);
    await readingBackstopJob.run({}, job);
    expect(await asked()).toEqual([]);
    await db.delete(valueSnapshots);
    await readingAt(21);
    await readingBackstopJob.run({}, job);
    expect(await asked()).toEqual([expect.objectContaining({ key: "reading" })]);
  });
});
