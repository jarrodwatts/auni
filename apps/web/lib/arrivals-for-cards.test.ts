import type { CardWire } from "@auni/shared";
import { expect, it } from "vitest";

import { arrivalsForCards } from "./arrivals-for-cards";
import type { AuniUiMessage } from "./conversation";

/** Only the fields that matter here; the rest of a card doesn't. */
const card = (kind: string, more: object = {}) => ({ kind, ...more }) as unknown as CardWire;
const arrived = (direction: "in" | "out" = "in") => card("arrival", { direction });
const plan = (proposalId = "plan-1") => card("action_plan", { proposalId });

function message(
  id: string,
  role: "user" | "assistant",
  cards: readonly CardWire[] = [],
  { posted = false, words = "", forPlan = "" } = {},
): AuniUiMessage {
  return {
    id,
    role,
    parts: [
      ...(words ? [{ type: "text" as const, text: words }] : []),
      ...(cards.length > 0
        ? [{ type: "data-cards" as const, id, data: { cards: [...cards] } }]
        : []),
    ],
    ...(posted ? { metadata: { posted: true, ...(forPlan ? { forPlan } : {}) } } : {}),
  } as AuniUiMessage;
}

// The next step, Start with $50, sat above the $60 that made it possible (2026-11-17).
it("gives money that came in right after a plan, while it waited, to that plan's card", () => {
  const turns = [
    message("take", "user"),
    message("answer", "assistant", [plan()], { words: "Here's your take" }),
    message("in", "assistant", [arrived()], { posted: true, forPlan: "plan-1" }),
    message("in2", "assistant", [arrived()], { posted: true, forPlan: "plan-1" }),
  ];
  const { told, folded } = arrivalsForCards(turns);
  expect(told.get(1)?.get("plan-1")).toHaveLength(2);
  expect([...folded]).toEqual([2, 3]);
});

it("gives it only to the plan it funds when one answer holds two", () => {
  const turns = [
    message("answer", "assistant", [plan("plan-1"), plan("plan-2")]),
    message("in", "assistant", [arrived()], { posted: true, forPlan: "plan-2" }),
  ];
  const told = arrivalsForCards(turns).told.get(0);
  expect(told?.get("plan-1")).toBeUndefined();
  expect(told?.get("plan-2")).toHaveLength(1);
});

it("leaves every other arrival where it came", () => {
  const plain = [message("hi", "user"), message("words", "assistant", [], { words: "Hello" })];
  const cases: AuniUiMessage[][] = [
    // After words alone.
    [...plain, message("in", "assistant", [arrived()], { posted: true })],
    // After a plan that had already settled: a $5,000 deposit four days on is no part of it, and
    // keeps its own day (2026-11-25 review).
    [
      message("a", "assistant", [plan()]),
      message("in", "assistant", [arrived()], { posted: true }),
    ],
    // While another plan, not this one, waited.
    [
      message("a", "assistant", [plan()]),
      message("in", "assistant", [arrived()], { posted: true, forPlan: "plan-2" }),
    ],
    // Money that left.
    [
      message("a", "assistant", [plan()]),
      message("out", "assistant", [arrived("out")], { posted: true }),
    ],
    // The owner said something in between.
    [
      message("a", "assistant", [plan()]),
      message("hi", "user"),
      message("in", "assistant", [arrived()], { posted: true, forPlan: "plan-1" }),
    ],
    // An answer of Auni's own, not news it posted.
    [message("a", "assistant", [plan()]), message("in", "assistant", [arrived()])],
  ];
  for (const turns of cases) expect(arrivalsForCards(turns).folded.size).toBe(0);
});
