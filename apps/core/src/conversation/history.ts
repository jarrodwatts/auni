import { z } from "zod";

import type { MessageRow } from "../db/schema.ts";

type HistoryMessage = Pick<MessageRow, "id" | "role" | "parts" | "supersedesId" | "metadata">;

// Keeps the prompt bounded; the newest history wins when a thread grows long.
const MAX_HISTORY_CHARS = 60_000;
const MAX_OUTCOME_CHARS = 200;

/** Each assistant message answers the owner message before it. */
export function replyTargets(
  messages: readonly Pick<MessageRow, "id" | "role">[],
): Map<string, string> {
  const targets = new Map<string, string>();
  let lastUserId: string | undefined;
  for (const message of messages) {
    if (message.role === "user") lastUserId = message.id;
    else if (lastUserId) targets.set(message.id, lastUserId);
  }
  return targets;
}

/** Drops edited-away user messages and the answers they got. */
export function visibleMessages<T extends HistoryMessage>(messages: readonly T[]): T[] {
  const superseded = new Set(
    messages.flatMap((message) => (message.supersedesId ? [message.supersedesId] : [])),
  );
  if (superseded.size === 0) return [...messages];
  const targets = replyTargets(messages);
  return messages.filter((message) =>
    message.role === "user"
      ? !superseded.has(message.id)
      : !superseded.has(targets.get(message.id) ?? ""),
  );
}

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly state?: string;
  readonly output?: unknown;
  readonly errorText?: string;
}

export function messageText(parts: readonly unknown[]): string {
  return (parts as Part[])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One line per finished tool call, so the agent remembers what it did and what came of it. */
function outcomeLines(parts: readonly unknown[]): string[] {
  return (parts as Part[]).flatMap((part) => {
    if (!part.type.startsWith("tool-")) return [];
    const name = part.type.slice("tool-".length);
    if (part.state === "output-error")
      return [`  (${name} failed: ${clip(part.errorText ?? "", MAX_OUTCOME_CHARS)})`];
    if (part.state !== "output-available") return [`  (${name} did not finish)`];
    const output =
      typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");
    return [`  (${name}: ${clip(output, MAX_OUTCOME_CHARS)})`];
  });
}

function renderMessage(message: HistoryMessage): string {
  if (message.role === "user") return `User: ${messageText(message.parts)}`;
  const lines = [
    ...(message.metadata.reason ? [`(Background: ${message.metadata.reason})`] : []),
    ...outcomeLines(message.parts),
  ];
  const text = messageText(message.parts);
  if (text) lines.push(`Auni: ${text}`);
  if (message.metadata.stopped) lines.push("(The owner stopped this answer.)");
  return lines.join("\n");
}

/** A watch that fired, so its answer is marked with it and recorded as its outcome. */
export const watchFireSchema = z.object({
  automationId: z.uuid(),
  fireId: z.uuid(),
  /** The watch as the person saw it set up: its description. */
  watch: z.string(),
});
export type WatchFire = z.infer<typeof watchFireSchema>;

export type TurnTrigger =
  | { readonly kind: "message"; readonly messageId: string }
  | {
      readonly kind: "background";
      readonly reason: string;
      readonly fires?: WatchFire[];
      /** The fires a daily brief tells of, marked briefed once its answer is kept. */
      readonly briefed?: readonly string[];
    };

interface TurnPrompt {
  /** Earlier messages, oldest first, one rendered message each. */
  readonly history: readonly string[];
  /** What this turn responds to. */
  readonly now: string;
}

/** Compact history, then what this turn responds to. Undefined once its message was edited away. */
export function renderTurnPrompt(
  visible: readonly HistoryMessage[],
  trigger: TurnTrigger,
): TurnPrompt | undefined {
  let earlier: readonly HistoryMessage[] = visible;
  let now: string;
  if (trigger.kind === "message") {
    const index = visible.findIndex((message) => message.id === trigger.messageId);
    const message = visible[index];
    if (!message) return undefined;
    // Everything said before this turn, but the owner's later messages, which turns of their own
    // answer next: an answer to an earlier message can sort after this one, its turn begun once
    // this one was sent (two sent at once), and is still history here.
    earlier = visible.filter((other, at) => at < index || (at > index && other.role !== "user"));
    now = messageText(message.parts);
  } else {
    now = `Nothing new from the owner. Background event: ${trigger.reason}\nDecide what the owner needs to know or what to do next, and reply to them. If nothing in it is worth their attention, call settle_quietly with why instead, and write nothing.`;
    // The answer's first sentence is kept as each fire's record in their watch list.
    if (trigger.fires)
      now += ` Open with one short sentence saying what happened and what you did or suggest about it.`;
  }

  const history: string[] = [];
  let size = 0;
  for (const message of earlier.toReversed()) {
    const block = renderMessage(message);
    size += block.length;
    if (size > MAX_HISTORY_CHARS) break;
    if (block) history.unshift(block);
  }
  return { history, now };
}

/**
 * The prompt's blocks: each earlier message on its own, then this turn's context
 * and message. A message's block reads the same every turn after it, so the
 * history before this turn stays a cacheable prefix.
 */
export function promptBlocks({ history, now }: TurnPrompt, context: string): string[] {
  if (history.length === 0) return [`${context}\n\n${now}`];
  return [
    ...history.map((block, index) => `${index === 0 ? "<conversation_so_far>\n" : ""}${block}\n\n`),
    `</conversation_so_far>\n\n${context}\n\n${now}`,
  ];
}
