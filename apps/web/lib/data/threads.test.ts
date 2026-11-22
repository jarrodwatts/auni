import { threadWireSchema, type ThreadId } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { toThread } from "./threads";

const THREAD = "7d0c0000-0000-4000-8000-000000000001" as ThreadId;

describe("a thread row from core", () => {
  const wire = {
    id: THREAD,
    title: "Buy SOL",
    status: "idle",
    actMode: "ask_first",
    budgetUsd: "0",
    pinnedAt: null,
    modelSelection: null,
    notes: null,
    archivedAt: null,
    moneyLine: null,
    lastActivityAt: "2026-10-28T09:00:00.000Z",
    createdAt: "2026-10-28T08:00:00.000Z",
  };

  it("carries its money in motion, counted by legs", () => {
    const moving = { done: 1, failed: 0, total: 3 };
    expect(toThread(threadWireSchema.parse({ ...wire, moving })).moving).toEqual(moving);
  });

  it("has no money in motion when core leaves it out", () => {
    expect(toThread(threadWireSchema.parse(wire)).moving).toBeNull();
  });

  it("refuses a count with no legs", () => {
    const moving = { done: 0, failed: 0, total: 0 };
    expect(threadWireSchema.safeParse({ ...wire, moving }).success).toBe(false);
  });
});
