import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";
import { actions, arrivalCursors } from "../db/schema.ts";
import { insertAction, wipe } from "../test/db.ts";
import { statementDue } from "./statements.ts";

beforeEach(() => wipe(actions, arrivalCursors));

/** The statement of `venue` as last read `msAgo`. */
const readAt = (venue: string, msAgo: number) =>
  db
    .insert(arrivalCursors)
    .values({ chain: venue, block: Date.now() - msAgo })
    .onConflictDoUpdate({ target: arrivalCursors.chain, set: { block: Date.now() - msAgo } });

describe("statementDue", () => {
  it("is due once money moved at the venue and its statement wasn't read in 10 minutes", async () => {
    // No money at the venue: nothing to read.
    await insertAction({ venue: "base" });
    // A cursor of another kind is no statement read.
    await db.insert(arrivalCursors).values({ chain: "base", block: 5 });
    expect(await statementDue("hyperliquid")).toBe(false);

    await insertAction({ tool: "hyperliquid_deposit", venue: "hyperliquid" });
    expect(await statementDue("hyperliquid")).toBe(true);
    await readAt("hyperliquid", 20 * 60_000);
    expect(await statementDue("hyperliquid")).toBe(true);
    // A move's own read moments ago stands: a sweep now asks the venue nothing.
    await readAt("hyperliquid", 60_000);
    expect(await statementDue("hyperliquid")).toBe(false);
  });

  it("weighs each venue by its own moves and its own cursor", async () => {
    await insertAction({ tool: "hyperliquid_deposit", venue: "hyperliquid" });
    await insertAction({ tool: "otherperps_order", venue: "otherperps" });
    await readAt("hyperliquid", 60_000);

    expect(await statementDue("hyperliquid")).toBe(false);
    expect(await statementDue("otherperps")).toBe(true);
    expect(await statementDue("nomoves")).toBe(false);
  });
});
