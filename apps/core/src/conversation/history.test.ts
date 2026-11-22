import { describe, expect, it } from "vitest";

import type { MessageRow } from "../db/schema.ts";
import { promptBlocks, renderTurnPrompt, visibleMessages } from "./history.ts";

function message(
  id: string,
  role: "user" | "assistant",
  parts: unknown[],
  extra: Partial<Pick<MessageRow, "supersedesId" | "metadata">> = {},
) {
  return {
    id,
    role,
    parts,
    supersedesId: extra.supersedesId ?? null,
    metadata: extra.metadata ?? {},
  };
}
const text = (value: string) => ({ type: "text", text: value });

describe("visibleMessages", () => {
  it("drops an edited-away question together with its answer", () => {
    const rows = [
      message("u1", "user", [text("Buy $50 of NVDA")]),
      message("a1", "assistant", [text("Done.")]),
      message("u2", "user", [text("Buy $60 of NVDA")], { supersedesId: "u1" }),
    ];

    expect(visibleMessages(rows).map(({ id }) => id)).toEqual(["u2"]);
  });
});

describe("renderTurnPrompt", () => {
  it("renders each prior message as its own block, then the context and the new message", () => {
    const rows = [
      message("u1", "user", [text("What's my balance?")]),
      message("a1", "assistant", [
        { type: "tool-get_portfolio", state: "output-available", output: { totalUsd: 120 } },
        text("You have $120."),
      ]),
      message("u2", "user", [text("Put half in Aave")]),
    ];

    const prompt = renderTurnPrompt(rows, { kind: "message", messageId: "u2" });
    expect(promptBlocks(prompt!, "<system-reminder>Now</system-reminder>")).toEqual([
      "<conversation_so_far>\nUser: What's my balance?\n\n",
      '  (get_portfolio: {"totalUsd":120})\nAuni: You have $120.\n\n',
      "</conversation_so_far>\n\n<system-reminder>Now</system-reminder>\n\nPut half in Aave",
    ]);
  });

  it("keeps an earlier question's answer that sorts after this message, never a later question", () => {
    // Two sent at once: the first's turn began after the second was stored, so its answer sorts
    // after it, and a third came in while that answer was written.
    const rows = [
      message("u1", "user", [text("What's my balance?")]),
      message("u2", "user", [text("And my positions?")]),
      message("a1", "assistant", [text("You have $120.")]),
      message("u3", "user", [text("And in cash?")]),
    ];

    expect(renderTurnPrompt(rows, { kind: "message", messageId: "u2" })).toEqual({
      history: ["User: What's my balance?", "Auni: You have $120."],
      now: "And my positions?",
    });
  });

  it("answers nothing once the turn's own message was edited away", () => {
    const rows = visibleMessages([
      message("u1", "user", [text("first")]),
      message("u2", "user", [text("second")], { supersedesId: "u1" }),
    ]);

    expect(renderTurnPrompt(rows, { kind: "message", messageId: "u1" })).toBeUndefined();
  });

  it("gives a background turn its trusted reason instead of a user message", () => {
    const prompt = renderTurnPrompt([message("u1", "user", [text("Buy NVDA")])], {
      kind: "background",
      reason: "Your NVDA buy filled at $182.10.",
    });

    expect(prompt?.history).toEqual(["User: Buy NVDA"]);
    expect(prompt?.now).toContain("Background event: Your NVDA buy filled at $182.10.");
  });
});
