import { describe, expect, it } from "vitest";

import { askFace, doneTitle } from "./ask-face";

describe("askFace", () => {
  it("draws a thread's budget as the figure and how it acts under the title", () => {
    expect(
      askFace({
        summary: "Let Peptides trade on its own up to $1,500",
        lines: [
          { label: "Thread", value: "Peptides go mainstream by 2028" },
          { label: "Budget", value: "$1,500" },
          { label: "How it acts", value: "Buys and sells inside the budget without asking." },
        ],
        action: "Allow $1,500 budget",
      }),
    ).toEqual({
      title: "Let Peptides trade on its own up to $1,500",
      line: "Buys and sells inside the budget without asking.",
      figure: { value: "$1,500", label: "budget" },
      details: [{ label: "Thread", value: "Peptides go mainstream by 2028" }],
      action: "Allow $1,500 budget",
    });
  });

  it("leaves out no line of an ask it knows nothing of", () => {
    const lines = [
      { label: "Thread", value: "AI buildout" },
      { label: "It may", value: "Buy and sell within its $4,000 budget without asking you." },
    ];
    const action = "Let it trade $4,000";
    expect(
      askFace({ summary: "Let AI buildout act on its own with $4,000", lines, action }),
    ).toEqual({
      title: "Let AI buildout act on its own with $4,000",
      line: null,
      figure: null,
      details: lines,
      action,
    });
  });
});

// A finished money card reads in the past tense; a finished ask read as the command it was.
describe("doneTitle", () => {
  it("says a finished ask in the past tense", () => {
    expect(doneTitle("Save a routine: Friday check")).toBe("Saved routine: Friday check");
    expect(doneTitle("Replace your routine: Friday check")).toBe(
      "Replaced your routine: Friday check",
    );
    expect(doneTitle("Turn Elfa on")).toBe("Turned Elfa on");
    expect(doneTitle("Let this thread trade on its own up to $500")).toBe(
      "This thread can now trade on its own up to $500",
    );
    expect(doneTitle("Let Peptides trade on its own up to $1,500")).toBe(
      "Peptides can now trade on its own up to $1,500",
    );
  });

  it("leaves one it has no past tense for to its own words", () => {
    expect(doneTitle("Your Solana key")).toBeNull();
  });
});
