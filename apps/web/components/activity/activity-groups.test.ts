import type { ActivityItemWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { activityGroups, amountText } from "./activity-groups";

/** Oct 26, 2026, mid-morning, in whatever time zone the tests run in. */
const NOW = new Date(2026, 9, 26, 10).getTime();

const item = (id: string, at: Date) => ({ id, at: at.toISOString() }) as ActivityItemWire;

describe("activityGroups", () => {
  it("heads the past week, the rest of this month, then each month, with its year once it isn't this one", () => {
    const items = [
      item("pearl", new Date(2026, 9, 26, 9)),
      item("arrived", new Date(2026, 9, 20, 9)),
      item("strk", new Date(2026, 9, 14, 20, 21)),
      item("curve", new Date(2026, 9, 12)),
      item("september", new Date(2026, 8, 30)),
      item("december", new Date(2025, 11, 2)),
    ];
    expect(
      activityGroups(items, NOW).map(({ label, items: rows }) => [label, rows.map(({ id }) => id)]),
    ).toEqual([
      ["This week", ["pearl", "arrived"]],
      ["Earlier in October", ["strk", "curve"]],
      ["September", ["september"]],
      ["December 2025", ["december"]],
    ]);
  });

  it("keeps the past week whole when it reaches into last month", () => {
    const groups = activityGroups(
      [item("today", new Date(2026, 10, 2)), item("last-month", new Date(2026, 9, 30))],
      new Date(2026, 10, 2, 12).getTime(),
    );
    expect(groups.map(({ label }) => label)).toEqual(["This week"]);
  });

  it("has nothing to head when there is nothing", () => {
    expect(activityGroups([], NOW)).toEqual([]);
  });
});

describe("amountText", () => {
  it("signs only money in or out, and a buy reads plain", () => {
    expect(amountText({ usd: "50.00", direction: "in", tone: "gain" })).toBe("+$50");
    expect(amountText({ usd: "5.26", direction: "out", tone: "loss" })).toBe("−$5.26");
    expect(amountText({ usd: "16.50", direction: null, tone: "neutral" })).toBe("$16.50");
  });
});
