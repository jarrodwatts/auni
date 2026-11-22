import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appsWire } from "../../app-list.ts";
import { db } from "../../db/client.ts";
import { actions } from "../../db/schema.ts";
import { executeAction, prepareLeg } from "../../money/actions.ts";
import { insertAction, wipe } from "../../test/db.ts";
import { polymarketOrder } from "./order.ts";
import { forgetRegion } from "./region.ts";

// From a place where Polymarket takes no new bets, Auni offers none: core asks the app before
// any card with a buy there is described, so neither the bet nor a move bringing its cash is
// ever made (a plan's legs are each made here, and one that can't be made records nothing),
// and a bet allowed before is never run. Its answer is the one recorded from New South Wales.

const answer = (
  JSON.parse(
    readFileSync(new URL("fixtures/geoblock/blocked-au.json", import.meta.url), "utf8"),
  ) as {
    answer: unknown;
  }
).answer;

const BET = { market: "bitcoin-80k-november", outcome: "No", side: "buy", amountUsd: 1 };
const REFUSED =
  "Polymarket takes no new bets where this Auni runs (Australia), and Auni keeps to that. Selling a bet you hold there, and bringing your Polymarket cash home, still work.";

// The Apps list reads no brain and no wallet here: only what Polymarket's sheet says.
vi.mock(import("../../agent/brain.ts"), async (original) => ({
  ...(await original()),
  brainRows: async () => [],
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({ evm: null, solana: null }),
}));

/** Everything Auni asked of the outside world, which answers only Polymarket's region check. */
const asked: string[] = [];

beforeEach(async () => {
  forgetRegion();
  asked.length = 0;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    asked.push(String(url));
    if (String(url) === "https://polymarket.com/api/geoblock") return Response.json(answer);
    throw new TypeError("fetch failed");
  });
  await wipe(actions);
});
afterEach(() => vi.unstubAllGlobals());

describe("a Polymarket bet from where Polymarket takes no new bets", () => {
  it("is never made into a card, and asks Polymarket nothing else", async () => {
    await expect(prepareLeg(polymarketOrder, BET, { specialistId: null })).rejects.toThrow(REFUSED);
    expect(asked).toEqual(["https://polymarket.com/api/geoblock"]);
  });

  it("leaves a sale to Polymarket, which takes it from there", async () => {
    const sale = prepareLeg(
      polymarketOrder,
      { ...BET, side: "sell", shares: 1 },
      {
        specialistId: null,
      },
    );
    // Its card is read from Polymarket's book, which this test doesn't answer.
    await expect(sale).rejects.toThrow("fetch failed");
    expect(asked.some((url) => url.includes("polymarket.com/api/geoblock"))).toBe(false);
  });

  it("is never run once allowed: it fails as Polymarket's rule, with nothing sent", async () => {
    const { id } = await insertAction({
      tool: "polymarket_order",
      venue: "polymarket",
      input: BET,
      status: "running",
    });
    expect(await executeAction(id)).toMatchObject({
      status: "failed",
      failureKind: "rule",
      error: REFUSED,
      txs: [],
    });
    expect(asked).toEqual(["https://polymarket.com/api/geoblock"]);
    expect((await db.select().from(actions).where(eq(actions.id, id)))[0]?.status).toBe("failed");
  });

  it("goes as before when Polymarket's check can't be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: string | URL) => {
      asked.push(String(url));
      throw new TypeError("fetch failed");
    });
    // Past the check, the card is read from Polymarket's markets, which this test doesn't answer.
    await expect(prepareLeg(polymarketOrder, BET, { specialistId: null })).rejects.toThrow(
      "fetch failed",
    );
    expect(asked.some((url) => !url.includes("geoblock"))).toBe(true);
  });

  it("is said on Polymarket's sheet, first of what isn't working there", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { apps } = await appsWire();
    expect(apps.find(({ id }) => id === "polymarket")?.troubles[0]).toEqual({
      short: "No new bets from here",
      says: REFUSED,
    });
    expect(apps.filter(({ troubles }) => troubles.length > 0).map(({ id }) => id)).toEqual([
      "polymarket",
    ]);
  });
});
