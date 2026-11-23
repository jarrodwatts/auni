import { describe, expect, it } from "vitest";

import {
  initialAutoCollapsed,
  shouldAutoCollapse,
  uniqueStepIcons,
  workPanelHeaderLabel,
} from "./work-panel-model";

describe("uniqueStepIcons", () => {
  it("deduplicates tool icons in first-seen order and drops thought icons once tools run", () => {
    const steps = [
      { iconKey: "thought", isTool: false },
      { iconKey: "tool:get_portfolio", isTool: true },
      { iconKey: "app:hyperliquid", isTool: true },
      { iconKey: "tool:get_portfolio", isTool: true },
      { iconKey: "app:aave", isTool: true },
    ];
    expect(uniqueStepIcons(steps).map((step) => step.iconKey)).toEqual([
      "tool:get_portfolio",
      "app:hyperliquid",
      "app:aave",
    ]);
  });

  it("keeps the thought icon when a group has only thoughts, and caps the stack", () => {
    expect(uniqueStepIcons([{ iconKey: "thought", isTool: false }]).map((s) => s.iconKey)).toEqual([
      "thought",
    ]);
    const many = Array.from({ length: 8 }, (_, index) => ({
      iconKey: `tool:t${index}`,
      isTool: true,
    }));
    expect(uniqueStepIcons(many, 5)).toHaveLength(5);
  });
});

describe("workPanelHeaderLabel", () => {
  it("counts steps while a tool runs, reflects thinking between steps, and uses liveLabel when collapsed", () => {
    expect(
      workPanelHeaderLabel({
        active: true,
        anyRunning: true,
        open: true,
        liveLabel: "Checking live prices",
        toolCount: 1,
        thoughtCount: 0,
      }),
    ).toBe("Working on 1 step");
    expect(
      workPanelHeaderLabel({
        active: true,
        anyRunning: true,
        open: true,
        liveLabel: "Checking live prices",
        toolCount: 3,
        thoughtCount: 1,
      }),
    ).toBe("Working on 3 steps");
    expect(
      workPanelHeaderLabel({
        active: true,
        anyRunning: false,
        open: true,
        liveLabel: "Thinking",
        toolCount: 2,
        thoughtCount: 0,
      }),
    ).toBe("Thinking");
    expect(
      workPanelHeaderLabel({
        active: true,
        anyRunning: true,
        open: false,
        liveLabel: "Checking live prices",
        toolCount: 2,
        thoughtCount: 0,
      }),
    ).toBe("Checking live prices");
  });

  it("shows a compact summary once settled", () => {
    expect(
      workPanelHeaderLabel({ active: false, open: false, toolCount: 1, thoughtCount: 0 }),
    ).toBe("1 step");
    expect(
      workPanelHeaderLabel({ active: false, open: false, toolCount: 4, thoughtCount: 1 }),
    ).toBe("4 steps");
    expect(
      workPanelHeaderLabel({ active: false, open: false, toolCount: 0, thoughtCount: 1 }),
    ).toBe("Thought");
    expect(
      workPanelHeaderLabel({ active: false, open: false, toolCount: 0, thoughtCount: 0 }),
    ).toBe("Worked");
  });
});

describe("shouldAutoCollapse", () => {
  it("collapses only when all tool steps finished cleanly and the group is safe to close", () => {
    expect(shouldAutoCollapse({ hasSteps: true, anyIncomplete: false, canCollapse: true })).toBe(
      true,
    );
    expect(shouldAutoCollapse({ hasSteps: true, anyIncomplete: true, canCollapse: true })).toBe(
      false,
    );
    expect(shouldAutoCollapse({ hasSteps: true, anyIncomplete: false, canCollapse: false })).toBe(
      false,
    );
    expect(shouldAutoCollapse({ hasSteps: false, anyIncomplete: false, canCollapse: true })).toBe(
      false,
    );
  });
});

describe("initialAutoCollapsed", () => {
  it("mounts history panels collapsed only when all tool steps finished cleanly, keeping failures and stopped steps open", () => {
    expect(
      initialAutoCollapsed({
        liveOnMount: false,
        hasSteps: true,
        anyIncomplete: false,
        canCollapse: true,
      }),
    ).toBe(true);
    expect(
      initialAutoCollapsed({
        liveOnMount: false,
        hasSteps: true,
        anyIncomplete: true,
        canCollapse: true,
      }),
    ).toBe(false);
    expect(
      initialAutoCollapsed({
        liveOnMount: true,
        hasSteps: true,
        anyIncomplete: false,
        canCollapse: true,
      }),
    ).toBe(false);
  });
});
