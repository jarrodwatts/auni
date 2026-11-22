import { AUNI_TOOL_NAMES } from "@auni/shared";
import type { UIMessageChunk } from "ai";

import type { BrainEvent } from "../apps/contract.ts";
import { isSealed } from "./card-seal.ts";

// The one place a brain's events become what the web streams, so every brain shows the same
// things the same way, and none can show a card core didn't seal.

const AUNI_TOOLS: ReadonlySet<string> = new Set(AUNI_TOOL_NAMES);

interface Thought {
  /** The brain's id for it, and the one the web replaces in place as it grows. */
  readonly id: string;
  readonly uiId: string;
  readonly text: string;
  readonly sent: string;
}

interface State {
  /** The text block being written, by the brain's id. */
  readonly text: string | null;
  readonly thought: Thought | null;
  /** Thoughts are numbered across the turn, so each has an id of its own. */
  readonly thoughts: number;
  /** Each tool call's name, by its id, so a result knows whose it is. */
  readonly tools: ReadonlyMap<string, string>;
  readonly ended: boolean;
}

const START: State = { text: null, thought: null, thoughts: 0, tools: new Map(), ended: false };

type Step = { readonly chunks: UIMessageChunk[]; readonly state: State };

/** Thinking summaries come from a summarizer the product voice can't instruct. */
function plainThought(text: string): string {
  return text.replace(/\s*\u2014\s*/gu, ", ").trim();
}

/** Sends a thought whenever its shown text grows, under one id so the web replaces it in place. */
function sendThought(
  thought: Thought,
  shown: string,
): { chunks: UIMessageChunk[]; thought: Thought } {
  const text = plainThought(shown);
  if (!text || text === thought.sent) return { chunks: [], thought };
  return {
    chunks: [{ type: "data-reasoning", id: thought.uiId, data: { text } }],
    thought: { ...thought, sent: text },
  };
}

/** Ends the text block or thought in progress unless `event` goes on with it. */
function close(state: State, event: BrainEvent): Step {
  const chunks: UIMessageChunk[] = [];
  let next = state;
  if (state.text !== null && !(event.type === "text" && event.id === state.text)) {
    chunks.push({ type: "text-end", id: state.text });
    next = { ...next, text: null };
  }
  if (state.thought && !(event.type === "thinking" && event.id === state.thought.id)) {
    chunks.push(...sendThought(state.thought, state.thought.text).chunks);
    next = { ...next, thought: null };
  }
  return { chunks, state: next };
}

/** A tool result carrying `{ card, cardSeal }` that core sealed renders as a card. */
function cardChunk(id: string, output: unknown): UIMessageChunk[] {
  if (!output || typeof output !== "object") return [];
  const { card, cardSeal } = output as { card?: unknown; cardSeal?: unknown };
  if (!card || typeof card !== "object" || typeof (card as { kind?: unknown }).kind !== "string")
    return [];
  // The agent can write anything into its output; a card it made up, or changed after core
  // sealed it, never reaches the person.
  if (!isSealed(card, cardSeal)) return [];
  return [{ type: "data-cards", id, data: { cards: [card] } }];
}

/** Pure: the same (event, state) always gives the same (chunks, state). */
function translateEvent(event: BrainEvent, state: State): Step {
  const closed = close(state, event);
  const chunks = closed.chunks;
  let next = closed.state;
  switch (event.type) {
    case "text":
      if (next.text === null) {
        chunks.push({ type: "text-start", id: event.id });
        next = { ...next, text: event.id };
      }
      chunks.push({ type: "text-delta", id: event.id, delta: event.delta });
      break;
    case "thinking": {
      const thought = next.thought ?? {
        id: event.id,
        uiId: `reasoning-${next.thoughts}`,
        text: "",
        sent: "",
      };
      const text = thought.text + event.delta;
      // Summaries land a paragraph at a time; each finished one updates the thought in place.
      const sent = sendThought({ ...thought, text }, text.slice(0, text.lastIndexOf("\n\n") + 1));
      chunks.push(...sent.chunks);
      next = {
        ...next,
        thought: sent.thought,
        thoughts: next.thought ? next.thoughts : next.thoughts + 1,
      };
      break;
    }
    case "tool-call":
      chunks.push({
        type: "tool-input-available",
        toolCallId: event.id,
        toolName: event.name,
        input: event.input,
      });
      next = { ...next, tools: new Map(next.tools).set(event.id, event.name) };
      break;
    case "tool-result":
      // Only Auni's own tools return cards: one printed by the shell or typed in a reply is the
      // agent's invention, however well it copies a seal.
      if (AUNI_TOOLS.has(next.tools.get(event.id) ?? ""))
        chunks.push(...cardChunk(event.id, event.output));
      chunks.push(
        event.isError
          ? {
              type: "tool-output-error",
              toolCallId: event.id,
              errorText:
                typeof event.output === "string" ? event.output : JSON.stringify(event.output),
            }
          : { type: "tool-output-available", toolCallId: event.id, output: event.output },
      );
      break;
    case "done":
      chunks.push({ type: "finish", finishReason: "stop" });
      next = { ...next, ended: true };
      break;
    case "error":
      chunks.push({ type: "finish", finishReason: "error" });
      next = { ...next, ended: true };
      break;
    case "ready":
    case "limit":
    case "refused":
      break;
  }
  return { chunks, state: next };
}

interface TranslateOptions {
  readonly messageId: string;
  readonly metadata?: unknown;
}

/** A valid chunk stream: one start, the translated events, and an abort if the brain never finished. */
export async function* translate(
  events: AsyncIterable<BrainEvent>,
  options: TranslateOptions,
): AsyncIterable<UIMessageChunk> {
  yield {
    type: "start",
    messageId: options.messageId,
    ...(options.metadata !== undefined ? { messageMetadata: options.metadata } : {}),
  };
  let state = START;
  for await (const event of events) {
    if (state.ended) continue;
    const step = translateEvent(event, state);
    state = step.state;
    yield* step.chunks;
  }
  if (!state.ended) {
    yield* close(state, { type: "done" }).chunks;
    yield { type: "abort", reason: "the brain stopped before it finished" };
  }
}
