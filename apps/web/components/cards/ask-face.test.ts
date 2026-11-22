import { describe, expect, it } from "vitest";

import { askFace } from "./ask-face";

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
