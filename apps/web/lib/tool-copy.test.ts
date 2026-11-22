import { AUNI_TOOL_NAMES, MONEY_TOOL_NAMES, type SdkToolName } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { toolActivityTitle, toolCopy } from "./tool-copy";

describe("toolActivityTitle", () => {
  it("speaks in the present while a step runs and in the past once it is done", () => {
    expect(toolActivityTitle("hyperliquid_markets", "input-available")).toBe(
      "Checking live prices",
    );
    expect(toolActivityTitle("hyperliquid_markets", "output-available")).toBe(
      "Checked live prices",
    );
    expect(toolActivityTitle("hyperliquid_markets", "output-denied")).toBe(
      "Couldn’t check live prices",
    );
  });

  // A move's step only readies a card that waits for the person's OK, so its done line, which
  // sits beside a tick, must say it was prepared and never that the move happened.
  it.each(MONEY_TOOL_NAMES)("says %s prepared its move, not that the move is done", (tool) => {
    expect(toolActivityTitle(tool, "output-available")).toMatch(/^Prepared /);
    expect(toolActivityTitle(tool, "output-denied")).toMatch(/^Couldn’t prepare /);
  });

  it("says a deposit watch showed where to send money, not that the money landed", () => {
    expect(toolActivityTitle("wait_for_deposit", "output-available")).toBe(
      "Showed where to send your money",
    );
  });

  it("reads a tool it doesn't know as plain work", () => {
    expect(toolActivityTitle("some_new_tool", "input-streaming")).toBe("Working on this");
  });
});

describe("toolCopy", () => {
  it("keeps the agent's own working and the reply chips out of the steps, and nothing else", () => {
    const sdk: readonly SdkToolName[] = [
      "Agent",
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "Read",
      "Skill",
      "Task",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "TaskUpdate",
      "TodoWrite",
      "ToolSearch",
      "WebFetch",
      "WebSearch",
      "Write",
    ];
    const silent = [...AUNI_TOOL_NAMES, ...sdk, "some_new_tool"].filter(
      (name) => toolCopy(name) === "silent",
    );
    expect(silent.sort()).toEqual(
      [
        "suggest_replies",
        "name_chat",
        "load_skill",
        "read_chain",
        "fetch_url",
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "TodoWrite",
        "Task",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
        "TaskStop",
        "TaskOutput",
        "Agent",
        "ToolSearch",
        "Skill",
      ].sort(),
    );
  });
});
