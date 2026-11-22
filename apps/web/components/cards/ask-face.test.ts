import { describe, expect, it } from "vitest";

import { askFace } from "./ask-face";

describe("askFace", () => {
  it("draws a specialist's pot as the figure and how it acts under the title", () => {
    expect(
      askFace({
        summary: "Start a specialist: Peptides",
        lines: [
          { label: "A take", value: "Peptides go mainstream by 2028" },
          { label: "Pot", value: "$1,500" },
          { label: "How it acts", value: "Asks you before every move." },
        ],
        action: "Start with $1,500",
      }),
    ).toEqual({
      title: "Start a specialist: Peptides",
      line: "Asks you before every move.",
      figure: { value: "$1,500", label: "pot" },
      details: [{ label: "A take", value: "Peptides go mainstream by 2028" }],
      action: "Start with $1,500",
    });
  });

  it("leaves out no line of an ask it knows nothing of", () => {
    const lines = [
      { label: "Specialist", value: "AI buildout" },
      { label: "It may", value: "Buy and sell within its $4,000 pot without asking you." },
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
