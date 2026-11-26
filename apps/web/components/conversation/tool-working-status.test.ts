import { describe, expect, it } from "vitest";

import type { AuniUiMessage } from "@/lib/conversation";

import { answerWorkingLabel } from "./tool-working-status";

type Part = AuniUiMessage["parts"][number];

function turn(...parts: Part[]): AuniUiMessage {
  return { id: "answer", role: "assistant", parts };
}

const thought = (text: string): Part => ({ type: "data-reasoning", id: "r1", data: { text } });

const step = (tool: string, state: string): Part =>
  ({
    type: `tool-${tool}`,
    toolCallId: `${tool}:${state}`,
    state,
    input: {},
    ...(state === "output-available" ? { output: "{}" } : {}),
  }) as Part;

const shown = { showThinking: true };
const hidden = { showThinking: false };

describe("answerWorkingLabel", () => {
  it("names the step under way, whether or not thinking shows", () => {
    const message = turn(
      thought("Let me look at their cash."),
      step("get_portfolio", "input-available"),
    );
    expect(answerWorkingLabel(message, shown)).toBe("Checking your money");
    expect(answerWorkingLabel(message, hidden)).toBe("Checking your money");
  });

  it("says the newest sentence of a thought, or only that it is thinking when thoughts are hidden", () => {
    const message = turn(
      step("get_portfolio", "output-available"),
      thought("They have cash on Monad. SOL looks strong this week."),
    );
    expect(answerWorkingLabel(message, shown)).toBe("SOL looks strong this week.");
    expect(answerWorkingLabel(message, hidden)).toBe("Thinking");
  });

  it("says it is writing once words follow", () => {
    const message = turn(step("market_news", "output-available"), {
      type: "text",
      text: "SOL had a strong week.",
    });
    expect(answerWorkingLabel(message, hidden)).toBe("Writing");
  });

  it("reflects thinking or reviewing between steps", () => {
    expect(answerWorkingLabel(turn(step("market_news", "output-available")), shown)).toBe(
      "Thinking",
    );
    expect(answerWorkingLabel(turn(step("market_news", "output-denied")), shown)).toBe(
      "Reviewing what happened",
    );
  });

  it("says nothing before anything has happened", () => {
    expect(answerWorkingLabel(turn(), shown)).toBeNull();
  });
});
