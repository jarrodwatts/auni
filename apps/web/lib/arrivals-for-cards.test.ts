import type { CardWire } from "@auni/shared";
import { expect, it } from "vitest";

import { arrivalsForCards } from "./arrivals-for-cards";
import type { AuniUiMessage } from "./conversation";

/** Only the fields that matter here; the rest of a card doesn't. */
const card = (kind: string, more: object = {}) => ({ kind, ...more }) as unknown as CardWire;
const arrived = (direction: "in" | "out" = "in") => card("arrival", { direction });

function message(
  id: string,
  role: "user" | "assistant",
  cards: readonly CardWire[] = [],
  { posted = false, words = "" } = {},
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
    ...(posted ? { metadata: { posted: true } } : {}),
  } as AuniUiMessage;
}

// The next step, Start with $50, sat above the $60 that made it possible (2026-11-17).
it("gives money that came in right after a card that puts money in to that card", () => {
  const turns = [
    message("take", "user"),
    message("answer", "assistant", [card("specialist_proposal")], { words: "Here's your take" }),
    message("in", "assistant", [arrived()], { posted: true }),
    message("in2", "assistant", [arrived()], { posted: true }),
  ];
  const { told, folded } = arrivalsForCards(turns);
  expect(told.get(1)).toHaveLength(2);
  expect([...folded]).toEqual([2, 3]);
});

it("leaves every other arrival where it came", () => {
  const plain = [message("hi", "user"), message("words", "assistant", [], { words: "Hello" })];
  const cases: AuniUiMessage[][] = [
    // After words alone.
    [...plain, message("in", "assistant", [arrived()], { posted: true })],
    // Money that left.
    [
      message("a", "assistant", [card("action_plan")]),
      message("out", "assistant", [arrived("out")], { posted: true }),
    ],
    // The owner said something in between.
    [
      message("a", "assistant", [card("action_plan")]),
      message("hi", "user"),
      message("in", "assistant", [arrived()], { posted: true }),
    ],
    // An answer of Auni's own, not news it posted.
    [message("a", "assistant", [card("action_plan")]), message("in", "assistant", [arrived()])],
  ];
  for (const turns of cases) expect(arrivalsForCards(turns).folded.size).toBe(0);
});
