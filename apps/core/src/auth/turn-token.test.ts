import { describe, expect, it } from "vitest";

import { signTurnToken, verifyTurnToken } from "./turn-token.ts";

const SECRET = "a".repeat(32);
const CLAIMS = {
  threadId: "thread_1",
  turnStartedAt: "2026-09-30T00:00:00.000Z",
} as const;

describe("turn token", () => {
  it("round-trips the thread and turn claims", async () => {
    const token = await signTurnToken(CLAIMS, SECRET);

    expect(await verifyTurnToken(token, SECRET)).toEqual(CLAIMS);
  });

  it("rejects an expired token", async () => {
    const token = await signTurnToken(CLAIMS, SECRET, -1);

    await expect(verifyTurnToken(token, SECRET)).rejects.toThrow();
  });
});
