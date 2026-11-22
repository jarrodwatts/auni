import type { ActionCardWire, AutomationRuleId, CardWire } from "@auni/shared";
import { getToolName, isToolUIPart } from "ai";

import {
  isBlankText,
  isShownToolPart,
  messageCards,
  TEXT_PART_SEPARATOR,
  type AuniConversationActivityPart,
  type AuniUiMessage,
} from "@/lib/conversation";

/** A tool or skill activity and how much of the answer's text came before it. */
interface MessageTranscriptActivity {
  readonly key: string;
  readonly part: AuniConversationActivityPart;
  readonly cards: readonly CardWire[];
  /** Character offset into the message's joined text where this activity sat. */
  readonly offset: number;
}

/**
 * What an answer asks of the person, and a card an app draws (Elfa's tape)
 * that its words are about: always under its words, whenever the agent called for it.
 * Something to pass on to Auni's maintainers is one of these too: the agent is told its
 * card sits under the reply, and the words are what say why it is there.
 */
const ENDS_THE_ANSWER: ReadonlySet<CardWire["kind"]> = new Set([
  "specialist_proposal",
  "deposit",
  "ask",
  "app",
  "feedback",
]);

/**
 * What a money move is, without its size, so a retry at a new amount reads as the same move:
 * its tool, what its card calls it with the numbers left out, and the line under that (where
 * it runs, or the question it bets on).
 */
function moveShape({ tool, card }: ActionCardWire): string {
  return [tool, card.title.replace(/[\d.,]+/gu, "#"), card.context].join(":");
}

/**
 * Failed money attempts that a later try in the same answer got through:
 * the success tells the story, so the first try folds to a quiet line.
 */
function retriedCardIds(cards: readonly CardWire[]): ReadonlySet<string> {
  const failed = new Map<string, string[]>();
  const retried = new Set<string>();
  for (const card of cards) {
    if (card.kind !== "action") continue;
    const shape = moveShape(card);
    if (card.status === "failed") failed.set(shape, [...(failed.get(shape) ?? []), card.id]);
    if (card.status === "done") for (const id of failed.get(shape) ?? []) retried.add(id);
  }
  return retried;
}

/**
 * A proposal the agent replaced within the same answer never reached the person as a choice,
 * so only each specialist's latest one is drawn.
 */
function latestProposals(cards: readonly CardWire[]): CardWire[] {
  const latest = new Map<string, string>();
  for (const card of cards)
    if (card.kind === "specialist_proposal") latest.set(card.specialistId, card.id);
  return cards.filter(
    (card) => card.kind !== "specialist_proposal" || latest.get(card.specialistId) === card.id,
  );
}

export function messageTranscript(message: AuniUiMessage): {
  readonly activities: readonly MessageTranscriptActivity[];
  readonly trailingCards: readonly CardWire[];
  /** Failed attempts a later one fixed, drawn as a line instead of a card. */
  readonly retried: ReadonlySet<string>;
  /** Every watch the answer set up, drawn together as one line under it. */
  readonly watches: readonly AutomationRuleId[];
} {
  const activities: MessageTranscriptActivity[] = [];
  const allCards = messageCards(message);
  const remainingCards = new Map(
    allCards.filter(({ kind }) => kind !== "automation").map((card) => [card.id, card]),
  );
  // Core names a tool's cards part after the tool call, so its cards sit where the agent called it.
  const cardsByToolCall = new Map(
    message.parts.flatMap((part) =>
      part.type === "data-cards" && part.id
        ? [[part.id, part.data.cards.filter(({ kind }) => !ENDS_THE_ANSWER.has(kind))] as const]
        : [],
    ),
  );
  let offset = 0;
  let sawText = false;
  message.parts.forEach((part, index) => {
    if (part.type === "text") {
      if (isBlankText(part.text)) return;
      offset += (sawText ? TEXT_PART_SEPARATOR.length : 0) + part.text.length;
      sawText = true;
      return;
    }
    if (part.type === "data-reasoning") {
      activities.push({
        key: part.id ?? `reasoning:${index}`,
        part,
        offset,
        cards: [],
      });
      return;
    }
    // A silent tool's cards fall through to the end of the answer.
    if (isToolUIPart(part) && isShownToolPart(message.parts, index)) {
      const cards = (cardsByToolCall.get(part.toolCallId) ?? []).filter((card) =>
        remainingCards.has(card.id),
      );
      for (const card of cards) remainingCards.delete(card.id);
      // The same step run again back to back (two searches) reads as one step, the latest.
      const previous = activities.at(-1);
      if (
        previous?.offset === offset &&
        previous.cards.length === 0 &&
        isToolUIPart(previous.part) &&
        getToolName(previous.part) === getToolName(part)
      )
        activities.pop();
      activities.push({
        key: part.toolCallId,
        part: part as AuniConversationActivityPart,
        offset,
        cards,
      });
    }
  });
  return {
    activities,
    trailingCards: latestProposals([...remainingCards.values()]),
    retried: retriedCardIds(allCards),
    watches: allCards.flatMap((card) => (card.kind === "automation" ? [card.automationId] : [])),
  };
}
