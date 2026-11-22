import { AMOUNT, type ActionCardWire, type CardFace } from "@auni/shared";
import { describe, expect, it } from "vitest";

import type { AuniUiMessage } from "@/lib/conversation";

import { messageTranscript } from "./message-transcript";

/** A card's face with only what tells one move from another: its title and the line under it. */
const face = (title: string, context: string | null = null): CardFace => ({
  title,
  action: "Confirm",
  working: "Working on it",
  context,
  figures: [],
  finePrint: null,
  receipt: { title, detail: null, amount: null },
});

let next = 0;
const card = (tool: string, status: ActionCardWire["status"], said: CardFace): ActionCardWire => {
  const id = `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
  return { id, kind: "action", tool, status, card: said } as ActionCardWire;
};

/** The failed attempts an answer with these cards folds to a line, by where each sits. */
function folded(cards: readonly ActionCardWire[]): number[] {
  const message = {
    id: "m1",
    role: "assistant",
    parts: [{ type: "data-cards", data: { cards } }],
  } as unknown as AuniUiMessage;
  const { retried } = messageTranscript(message);
  return cards.flatMap(({ id }, index) => (retried.has(id) ? [index] : []));
}

describe("a failed attempt a later try got through", () => {
  const bet = (question: string) => face(`Buy Yes for ${AMOUNT}`, question);

  it("folds to a line, whatever amount the try that went through was for", () => {
    expect(
      folded([
        card("polymarket_order", "failed", bet("Will it rain?")),
        card("polymarket_order", "done", bet("Will it rain?")),
      ]),
    ).toEqual([0]);
    // Core's own sentence says its dollars, so the numbers are left out of what is compared.
    expect(
      folded([
        card("aave_supply", "failed", face("Put $10.00 into Aave savings on Monad")),
        card("aave_supply", "done", face("Put $8.50 into Aave savings on Monad")),
      ]),
    ).toEqual([0]);
    expect(
      folded([
        card("hyperliquid_order", "failed", face("Long BTC at 5x", "Hyperliquid")),
        card("hyperliquid_order", "done", face("Long BTC at 3x", "Hyperliquid")),
      ]),
    ).toEqual([0]);
  });

  it("stays a card when what went through was another move", () => {
    // The same side of another market.
    expect(
      folded([
        card("polymarket_order", "failed", bet("Will it rain?")),
        card("polymarket_order", "done", bet("Will it snow?")),
      ]),
    ).toEqual([]);
    // Another move by the same tool.
    expect(
      folded([
        card("send_evm_transaction", "failed", face("Stake 2 ETH with Lido")),
        card("send_evm_transaction", "done", face("Approve 0x2222…2222 to spend your USDC")),
      ]),
    ).toEqual([]);
    // A try that also failed fixes nothing.
    expect(
      folded([
        card("polymarket_order", "failed", bet("Will it rain?")),
        card("polymarket_order", "failed", bet("Will it rain?")),
      ]),
    ).toEqual([]);
  });
});

describe("where a card sits in an answer", () => {
  /** An answer that called `tool`, which made `made`, and then said something. */
  const answer = (tool: string, made: unknown) =>
    ({
      id: "m2",
      role: "assistant",
      parts: [
        { type: `tool-${tool}`, toolCallId: "call", state: "output-available", input: {} },
        { type: "data-cards", id: "call", data: { cards: [made] } },
        { type: "text", text: "Here it is." },
      ],
    }) as unknown as AuniUiMessage;

  it("keeps a money card where the agent made it, and what asks something of the person under the words", () => {
    const move = card("stock_trade", "awaiting_permission", face("Buy NVDA"));
    const placed = messageTranscript(answer("stock_trade", move));
    expect(placed.activities.flatMap(({ cards }) => cards)).toEqual([move]);
    expect(placed.trailingCards).toEqual([]);
    // The agent is told a feedback card sits under its reply, so its words come first.
    const feedback = { id: "f1", kind: "feedback" };
    const asked = messageTranscript(answer("send_feedback", feedback));
    expect(asked.activities.flatMap(({ cards }) => cards)).toEqual([]);
    expect(asked.trailingCards).toEqual([feedback]);
  });
});
