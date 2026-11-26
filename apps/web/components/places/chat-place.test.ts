import { expect, it } from "vitest";

import type { ThreadState } from "@/lib/data/views";

import { autoLabel } from "./chat-place";

// A take with $1,300 of $4,000 left said "Auto: $4,000 left" until its state read landed, and
// for good when that read failed (2026-11-25).
it("says what Auto has left only once the chat's state is read, never the whole budget for it", () => {
  const state: ThreadState = { budgetUsd: "4000.00", freeBudgetUsd: "1300.00", holdings: [] };
  expect(autoLabel(state)).toBe("Auto: $1,300 left");
  expect(autoLabel(undefined)).toBe("Auto");
});
