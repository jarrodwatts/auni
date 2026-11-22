import { beforeEach, describe, expect, it, vi } from "vitest";

import { appTroublesNow } from "../app-troubles.ts";
import { appTroubles } from "../db/schema.ts";
import { statementSweeps } from "../money/statements.ts";
import { wipe } from "../test/db.ts";
import { statementsJob } from "./statements.ts";

vi.mock("../money/statements.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  statementSweeps: vi.fn(() => []),
}));

const job = { id: "s", createdAt: new Date(), attempts: 1, signal: new AbortController().signal };
const PERPS = { id: "perps", name: "Perps" };
const OTHER = { id: "other", name: "Other" };

beforeEach(async () => {
  await wipe(appTroubles);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("statementsJob", () => {
  // The hourly read is the only one an owner who never opens Auni gets, so a venue that stops
  // answering it must show on its sheet, not only in the log.
  it("keeps a statement that can't be read on its app until it reads again, and reads the rest", async () => {
    const down = vi.fn(async (): Promise<void> => {
      throw new Error("Perps could not answer userFillsByTime (HTTP 500)");
    });
    const fine = vi.fn(async () => {});
    vi.mocked(statementSweeps).mockReturnValue([
      { app: PERPS, work: "reading its statement", run: down },
      { app: OTHER, work: "reading its statement", run: fine },
    ]);
    await statementsJob.run({}, job);
    expect(fine).toHaveBeenCalledOnce();
    expect(await appTroublesNow()).toMatchObject([
      {
        app: "perps",
        work: "reading its statement",
        kind: "failing",
        said: "Perps could not answer userFillsByTime (HTTP 500)",
        times: 1,
      },
    ]);

    down.mockResolvedValue(undefined);
    await statementsJob.run({}, job);
    expect(await appTroublesNow()).toEqual([]);
  });
});
