import {
  messageMetadataWireSchema,
  storedSuggestRepliesSchema,
  type CardWire,
  type ConversationToolName,
  type MessageDataParts,
  type MessageId,
  type ReplyOption,
} from "@auni/shared";
import { getToolName, isToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import type { z } from "zod";

import { toolCopy } from "@/lib/tool-copy";

interface AuniMessageMetadata {
  readonly workDurationMs?: number;
  /** Absent on an answer core started without the person (an automation, a finished action). */
  readonly origin?: "human";
  /** When the message was sent, for the timestamp under a user bubble. */
  readonly createdAt?: string;
  /** Present only on an answer the person stopped before Auni finished it. */
  readonly stopped?: true;
  /** An answer that only says no AI could think yet, which signing one in answers again. */
  readonly noBrain?: true;
  /** Core left it outside any turn, such as money arriving: never a live answer, nothing worked. */
  readonly posted?: true;
  /** The user message this one replaces after a regenerate or an edit-and-resend. */
  readonly supersedesMessageId?: MessageId;
  /** The user message an answer belongs to, so a replaced answer hides with its question. */
  readonly replyToMessageId?: MessageId;
  /** The watches whose firing started this answer. */
  readonly fires?: readonly MessageFire[];
}

export type MessageFire = NonNullable<z.infer<typeof messageMetadataWireSchema>["fires"]>[number];

type AuniUiTools = {
  readonly [Name in ConversationToolName]: { readonly input: unknown; readonly output: unknown };
};

export type AuniUiMessage = UIMessage<AuniMessageMetadata, MessageDataParts, AuniUiTools>;
export type AuniToolPart = ToolUIPart<AuniUiTools>;
type AuniReasoningPart = {
  readonly type: "data-reasoning";
  readonly id?: string;
  readonly data: MessageDataParts["reasoning"];
};
export type AuniConversationActivityPart = AuniToolPart | AuniReasoningPart;

export function createOptimisticUserMessage(
  id: string,
  content: string,
  options: {
    readonly supersedesMessageId?: MessageId;
    readonly sentAt?: number;
  } = {},
): AuniUiMessage {
  const { supersedesMessageId, sentAt = Date.now() } = options;
  return {
    id,
    metadata: {
      origin: "human",
      // A message drawn again before it is stored keeps the moment it was sent.
      createdAt: new Date(sentAt).toISOString(),
      ...(supersedesMessageId ? { supersedesMessageId } : {}),
    },
    role: "user",
    parts: [{ type: "text", text: content }],
  };
}

/**
 * The answer a running turn has yet to start: no parts, the shape its first chunk opens.
 * A sent turn's answers its prompt; a turn core started on its own answers nothing.
 */
export function pendingAnswer(prompt: AuniUiMessage | null): AuniUiMessage {
  return {
    id: `pending:${prompt?.id ?? "background"}`,
    role: "assistant",
    parts: [],
    metadata: prompt ? { origin: "human", replyToMessageId: prompt.id as MessageId } : {},
  };
}

/** Maps core's message metadata, stored or streamed, onto the transcript's. */
export function toAuniMetadata(raw: unknown): AuniMessageMetadata {
  const parsed = messageMetadataWireSchema.safeParse(raw ?? {});
  if (!parsed.success) return {};
  const {
    createdAt,
    fires,
    noBrain,
    origin,
    posted,
    replyToId,
    stopped,
    supersedesId,
    workDurationMs,
  } = parsed.data;
  return {
    // An answer core started on its own is not the person's to regenerate.
    ...(origin === "human" ? { origin } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(supersedesId ? { supersedesMessageId: supersedesId } : {}),
    ...(replyToId ? { replyToMessageId: replyToId } : {}),
    ...(stopped ? { stopped } : {}),
    ...(noBrain ? { noBrain } : {}),
    ...(posted ? { posted } : {}),
    ...(workDurationMs !== undefined ? { workDurationMs } : {}),
    ...(fires?.length ? { fires } : {}),
  };
}

/** Separate text blocks (the agent wrote, worked, wrote again) read as separate paragraphs. */
export const TEXT_PART_SEPARATOR = "\n\n";

/** The agent sometimes ends on whitespace or a zero-width space; that is no paragraph at all. */
export function isBlankText(text: string): boolean {
  return text.replace(/[\s\u200B-\u200D\uFEFF]/g, "") === "";
}

export function messageText(message: AuniUiMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" && !isBlankText(part.text) ? [part.text] : []))
    .join(TEXT_PART_SEPARATOR);
}

export function messageCards(message: AuniUiMessage): readonly CardWire[] {
  return message.parts.flatMap((part) => (part.type === "data-cards" ? part.data.cards : []));
}

/** A question Auni closed an answer on, docked above the reply box until anything follows it. */
export interface AuniQuestion {
  /** The suggest_replies call's id. */
  readonly id: string;
  /** Null when the options are offered with no question: the next things the owner might say. */
  readonly question: string | null;
  readonly options: readonly ReplyOption[];
  readonly multiple: boolean;
}

/**
 * The question an answer asks: its suggest_replies call. Auni asks it before writing the reply,
 * so the reply's text follows it; older answers ended on it.
 */
export function messageQuestion(message: AuniUiMessage | undefined): AuniQuestion | null {
  if (message?.role !== "assistant") return null;
  const index = message.parts.findLastIndex(
    (part) => isToolUIPart(part) && getToolName(part) === "suggest_replies",
  );
  const asked = message.parts[index];
  if (!asked || !isToolUIPart(asked) || asked.state !== "output-available") return null;
  // A card after it is what the turn settled on, so the question no longer stands.
  if (message.parts.slice(index + 1).some((part) => part.type === "data-cards")) return null;
  const input = storedSuggestRepliesSchema.safeParse(asked.input);
  if (!input.success) return null;
  const { question = null, options, multiple = false } = input.data;
  return { id: asked.toolCallId, question, options, multiple };
}

/** The question the message at `index` answers: a user message right after one. */
export function answeredQuestion(
  messages: readonly AuniUiMessage[],
  index: number,
): AuniQuestion | null {
  return messages[index]?.role === "user" ? messageQuestion(messages[index - 1]) : null;
}

/** Several picks read as one sentence: "A", "A and B", "A, B and C". */
export function joinPicks(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function messageToolParts(message: AuniUiMessage): readonly AuniToolPart[] {
  return message.parts.filter((part) => isToolUIPart(part)) as AuniToolPart[];
}

/** A tool call the timeline shows as a step. A failed call is the agent's own slip, not news. */
export function isShownToolPart(parts: AuniUiMessage["parts"], index: number): boolean {
  const part = parts[index];
  return (
    part !== undefined &&
    isToolUIPart(part) &&
    part.state !== "output-error" &&
    toolCopy(getToolName(part)) !== "silent"
  );
}

export function messageActivityParts(
  message: AuniUiMessage,
): readonly AuniConversationActivityPart[] {
  return message.parts.filter(
    (part, index): part is AuniConversationActivityPart =>
      isShownToolPart(message.parts, index) || part.type === "data-reasoning",
  );
}

/**
 * Each turn's key, in order. A prompt's first answer is keyed by the prompt, so it takes over
 * the stand-in drawn before it; a later answer to the same prompt (a turn core started on its
 * own) keeps its own id. Adding a turn never changes an earlier one's key, so nothing on
 * screen is drawn again from scratch.
 */
export function turnKeys(turns: readonly AuniUiMessage[]): string[] {
  const answered = new Set<string>();
  return turns.map((message) => {
    const prompt = message.role === "assistant" ? message.metadata?.replyToMessageId : undefined;
    if (!prompt || answered.has(prompt)) return message.id;
    answered.add(prompt);
    return `answer:${prompt}`;
  });
}

export function answerStartedAt(
  messages: readonly AuniUiMessage[],
  index: number,
): string | undefined {
  const answer = messages[index];
  const prompt = messages[index - 1];
  const replyTo = answer?.metadata?.replyToMessageId;
  if (
    prompt?.role === "user" &&
    prompt.metadata?.createdAt &&
    (replyTo === undefined || replyTo === prompt.id)
  )
    return prompt.metadata.createdAt;
  return answer?.metadata?.createdAt;
}

export function visibleThreadMessages(
  messages: readonly AuniUiMessage[],
): readonly AuniUiMessage[] {
  const superseded = new Set<string>();
  for (const message of messages) {
    const replaced = message.metadata?.supersedesMessageId;
    if (replaced) superseded.add(replaced);
  }
  if (superseded.size === 0) return messages;

  return messages.filter((message) =>
    message.role === "user"
      ? !superseded.has(message.id)
      : !superseded.has(message.metadata?.replyToMessageId ?? ""),
  );
}

/** The last exchange a person may regenerate or edit, when there is one. */
export function editableExchange(
  messages: readonly AuniUiMessage[],
): { readonly userMessageId: string; readonly text: string } | null {
  const answer = messages.at(-1);
  const prompt = messages.at(-2);
  if (answer?.role !== "assistant" || answer.metadata?.origin !== "human") return null;
  if (prompt?.role !== "user" || prompt.metadata?.origin !== "human") return null;
  const answeredId = answer.metadata.replyToMessageId;
  if (answeredId && answeredId !== prompt.id) return null;

  const text = prompt.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length === 0 ? null : { userMessageId: prompt.id, text };
}
