import { describe, expect, it } from "vitest";

import { endsOnQuestion, threadUnread } from "./threads.ts";

const asked = { type: "tool-suggest_replies", state: "output-available", asks: true };

describe("endsOnQuestion", () => {
  it("stands while the answer's last question finished and nothing settled after it", () => {
    expect(endsOnQuestion([asked])).toBe(true);
    expect(endsOnQuestion([{ type: "data-cards" }, asked])).toBe(true);
  });

  it("falls when a card follows the question, or the question never finished", () => {
    expect(endsOnQuestion([asked, { type: "data-cards" }])).toBe(false);
    expect(
      endsOnQuestion([{ type: "tool-suggest_replies", state: "input-available", asks: true }]),
    ).toBe(false);
    expect(endsOnQuestion([])).toBe(false);
  });

  it("never stands for options offered with no question: those wait on no one", () => {
    expect(endsOnQuestion([{ ...asked, asks: false }])).toBe(false);
  });
});

describe("threadUnread", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 12, minute));

  it("is unread once an answer lands after the person last looked", () => {
    expect(threadUnread({ repliedAt: at(5), readAt: at(1) })).toBe(true);
    expect(threadUnread({ repliedAt: at(5), readAt: null })).toBe(true);
  });

  it("is read when nothing was answered or the person looked since", () => {
    expect(threadUnread({ repliedAt: null, readAt: null })).toBe(false);
    expect(threadUnread({ repliedAt: at(5), readAt: at(5) })).toBe(false);
    expect(threadUnread({ repliedAt: at(5), readAt: at(6) })).toBe(false);
  });
});
