import type { MessageId } from "@auni/shared";
import { describe, expect, it } from "vitest";

import {
  messageQuestion,
  pendingAnswer,
  toAuniMetadata,
  turnKeys,
  visibleThreadMessages,
  type AuniUiMessage,
} from "./conversation";

const prompt: AuniUiMessage = { id: "prompt", role: "user", parts: [] };

function answer(id: string, replyTo = prompt.id): AuniUiMessage {
  return {
    id,
    role: "assistant",
    parts: [],
    metadata: { replyToMessageId: replyTo as MessageId },
  };
}

describe("turnKeys", () => {
  it("gives a prompt's first answer the key of the stand-in drawn before it", () => {
    expect(turnKeys([prompt, pendingAnswer(prompt)])).toEqual(["prompt", "answer:prompt"]);
    expect(turnKeys([prompt, answer("first")])).toEqual(["prompt", "answer:prompt"]);
  });

  it("keeps an answer's key when a later turn answers the same prompt", () => {
    // A finished move wakes Auni, and its turn answers the person's last message too.
    expect(turnKeys([prompt, answer("first"), answer("woken")])).toEqual([
      "prompt",
      "answer:prompt",
      "woken",
    ]);
  });
});

describe("messageQuestion", () => {
  const asking = (input: unknown, after: readonly unknown[] = []) =>
    ({
      id: "asked",
      role: "assistant",
      parts: [
        { type: "tool-suggest_replies", toolCallId: "call", state: "output-available", input },
        ...after,
      ],
    }) as unknown as AuniUiMessage;

  it("reads a question, and replies offered with none", () => {
    const options = [{ label: "Yes" }, { label: "No" }];
    expect(messageQuestion(asking({ question: "Go ahead?", options }))).toEqual({
      id: "call",
      question: "Go ahead?",
      options,
      multiple: false,
    });
    expect(messageQuestion(asking({ options: [{ label: "Show me the plan" }] }))).toMatchObject({
      question: null,
      options: [{ label: "Show me the plan" }],
    });
  });

  it("stands down once a card follows it", () => {
    const card = { type: "data-cards", data: { cards: [] } };
    expect(messageQuestion(asking({ options: [{ label: "Yes" }] }, [card]))).toBeNull();
  });

  it("docks Try again under an answer cut off with its card, which still stands above", () => {
    // As core keeps a turn cut off when Auni died (keepCutTurn in conversation/turn.ts).
    const cut = {
      id: "cut",
      role: "assistant",
      parts: [
        { type: "text", text: "Here it is on one card.", state: "done" },
        { type: "data-cards", id: "call-1", data: { cards: [] } },
        { type: "text", text: "I was cut off partway through this.", state: "done" },
        {
          type: "tool-suggest_replies",
          toolCallId: "cut-1",
          state: "output-available",
          input: { options: [{ label: "Try again" }] },
          output: "Offered: Try again",
        },
      ],
    } as unknown as AuniUiMessage;
    expect(messageQuestion(cut)).toEqual({
      id: "cut-1",
      question: null,
      options: [{ label: "Try again" }],
      multiple: false,
    });
  });
});

describe("visibleThreadMessages", () => {
  const quiet = (id: string, extra: object = {}): AuniUiMessage => ({
    id,
    role: "assistant",
    parts: [],
    metadata: toAuniMetadata({ quiet: "The card shows it landed.", ...extra }),
  });

  it("hides an answer Auni settled quietly, since the card it is about already says how it went", () => {
    expect(
      visibleThreadMessages([prompt, answer("first"), quiet("woken")]).map(({ id }) => id),
    ).toEqual(["prompt", "first"]);
  });

  it("keeps a quiet-marked answer that has words or a card, so a warning or move is never hidden", () => {
    const warned = {
      ...quiet("warned"),
      parts: [
        { type: "text", text: "The order status is unknown. Check it before trying again." },
        { type: "tool-settle_quietly", toolCallId: "settle", state: "output-available" },
      ],
    } as AuniUiMessage;
    const carded = {
      ...quiet("carded"),
      parts: [{ type: "data-cards", id: "move", data: { cards: [] } }],
    } as unknown as AuniUiMessage;
    expect(
      visibleThreadMessages([prompt, warned, carded, quiet("woken")]).map(({ id }) => id),
    ).toEqual(["prompt", "warned", "carded"]);
  });

  it("keeps a watch's quiet answer, as what came of the watch", () => {
    const fired = quiet("fired", {
      fires: [
        {
          fireId: "0b6c9f0e-2a54-4a8e-9a39-6f1f7f8f2a10",
          automationId: "5f3a1b2c-7d4e-4f60-8a91-2b3c4d5e6f70",
          watch: "Solana drops 5%",
        },
      ],
    });
    expect(fired.metadata?.fires).toBeDefined();
    expect(visibleThreadMessages([prompt, fired]).map(({ id }) => id)).toEqual(["prompt", "fired"]);
  });
});
