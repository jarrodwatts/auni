import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { threads } from "../db/schema.ts";
import { sweepWhenDue } from "../money/sweep.ts";
import { insertThread, wipe } from "../test/db.ts";
import { sweepJob } from "./sweep.ts";

vi.mock("../money/sweep.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepWhenDue: vi.fn(),
}));

const job = {
  id: "sweep",
  createdAt: new Date(),
  attempts: 1,
  signal: new AbortController().signal,
};

beforeEach(async () => {
  await wipe(threads);
  vi.mocked(sweepWhenDue).mockReset();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-06T00:00:00Z") });
});
afterEach(() => vi.useRealTimers());

describe("sweepJob", () => {
  it("sweeps when due, sooner while a thread waits for a deposit, and not for a day-old wait", async () => {
    await sweepJob.run({}, job);
    await insertThread({ awaitingDepositSince: new Date() });
    await sweepJob.run({}, job);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    await sweepJob.run({}, job);
    expect(vi.mocked(sweepWhenDue).mock.calls).toEqual([[false], [true], [false]]);
  });
});
