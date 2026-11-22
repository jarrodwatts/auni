import { RETRACTED } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { untapped } from "./untapped";

const leg = (
  status: Parameters<typeof untapped>[0][number]["status"],
  error: string | null = null,
) => ({
  status,
  error,
});

describe("untapped", () => {
  it("says how a card ended before any tap: updated, taken back and why, or declined", () => {
    expect(untapped([leg("replaced"), leg("replaced")])).toBe("Updated below");
    expect(untapped([leg("retracted", RETRACTED.stale)])).toBe(RETRACTED.stale);
    expect(untapped([leg("cancelled"), leg("cancelled")])).toBe("You said not now");
  });

  it("is null for a card still waiting, or one the owner allowed", () => {
    expect(untapped([leg("awaiting_permission")])).toBeNull();
    expect(untapped([leg("done"), leg("cancelled")])).toBeNull();
    expect(untapped([])).toBeNull();
  });
});
