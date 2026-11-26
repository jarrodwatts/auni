import { describe, expect, it } from "vitest";

import { stepsFold, stepsSummary, turnBlocks } from "./turn-model";

describe("turnBlocks", () => {
  it("keeps each thought on its own and runs steps together, in order", () => {
    expect(
      turnBlocks([
        { thought: "a" },
        { step: 1 },
        { step: 2 },
        { thought: "b" },
        { thought: "c" },
        { step: 3 },
      ]),
    ).toEqual([
      { kind: "thought", thought: "a" },
      { kind: "steps", steps: [1, 2] },
      { kind: "thought", thought: "b" },
      { kind: "thought", thought: "c" },
      { kind: "steps", steps: [3] },
    ]);
  });
});

describe("stepsSummary", () => {
  it("says what was done in the steps' own words, never a count or a time", () => {
    expect(stepsSummary(["Checked your money"])).toBe("Checked your money");
    expect(stepsSummary(["Checked your money", "Put your moves together"])).toBe(
      "Checked your money and put your moves together",
    );
    expect(
      stepsSummary(["Searched the web", "Read a page", "Read a page", "Checked live prices"]),
    ).toBe("Searched the web, read a page and checked live prices");
    expect(stepsSummary([])).toBe("");
  });
});

describe("stepsFold", () => {
  it("folds a finished run once something follows it", () => {
    expect(stepsFold({ statuses: ["done", "done"], over: true })).toBe(true);
    expect(stepsFold({ statuses: ["done", "done"], over: false })).toBe(false);
  });

  it("stays open while a step runs, or when one failed or never finished", () => {
    expect(stepsFold({ statuses: ["done", "now"], over: true })).toBe(false);
    expect(stepsFold({ statuses: ["done", "failed"], over: true })).toBe(false);
    expect(stepsFold({ statuses: [null], over: true })).toBe(false);
  });
});
