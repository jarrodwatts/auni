import { beforeEach, describe, expect, it, vi } from "vitest";

import { appTroublesNow, attempt, clearTrouble, noteTrouble } from "./app-troubles.ts";
import { OutOfCredits } from "./apps/contract.ts";
import { appTroubles } from "./db/schema.ts";
import { env } from "./env.ts";
import { wipe } from "./test/db.ts";

const VENUE = { id: "venue", name: "Venue" };

beforeEach(async () => {
  await wipe(appTroubles);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("an app's trouble", () => {
  it("stands from the first failure of a piece of work until that work goes right, counting each", async () => {
    const reading = () => attempt(VENUE, "reading payouts", async () => Promise.reject(gone));
    const gone = new Error("Venue answered HTTP 410");
    await expect(reading()).rejects.toBe(gone);
    await expect(reading()).rejects.toBe(gone);
    expect(await appTroublesNow()).toMatchObject([
      { app: "venue", work: "reading payouts", kind: "failing", times: 2 },
    ]);
    // Other work going right says nothing of this one.
    await attempt(VENUE, "reading its statement", async () => {});
    expect(await appTroublesNow()).toHaveLength(1);
    await attempt(VENUE, "reading payouts", async () => {});
    expect(await appTroublesNow()).toEqual([]);
  });

  it("keeps a key out of credits once an app, whichever of its work found it, until any goes right", async () => {
    await noteTrouble(VENUE, "answering market_news", new OutOfCredits("Venue"));
    await noteTrouble(VENUE, "answering market_pulse", new OutOfCredits("Venue"));
    await noteTrouble({ id: "other", name: "Other" }, "watching", new OutOfCredits("Other"));
    const standing = await appTroublesNow();
    expect(standing.map(({ app, kind, times }) => ({ app, kind, times }))).toEqual([
      { app: "venue", kind: "credits", times: 2 },
      { app: "other", kind: "credits", times: 1 },
    ]);
    // An answer to any of its work shows it has credits again; the other app's still stands.
    await clearTrouble(VENUE, "answering market_pulse");
    expect((await appTroublesNow()).map(({ app }) => app)).toEqual(["other"]);
  });

  it("says what went wrong with every link cut to its host and none of core's secrets", async () => {
    const before = env.ALCHEMY_API_KEY;
    env.ALCHEMY_API_KEY = "alchemy-key-0123456789";
    try {
      await noteTrouble(
        VENUE,
        "reading payouts",
        new Error(
          "HTTP request failed. URL: https://rpc.example/v2/alchemy-key-0123456789?apiKey=abc123 said alchemy-key-0123456789 is over its limit\nat fetch (node:internal)",
        ),
      );
    } finally {
      env.ALCHEMY_API_KEY = before;
    }
    expect((await appTroublesNow()).map(({ said }) => said)).toEqual([
      "HTTP request failed. URL: rpc.example said … is over its limit",
    ]);
  });
});
