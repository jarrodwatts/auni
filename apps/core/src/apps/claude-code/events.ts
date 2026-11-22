import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { BrainEvent } from "../contract.ts";

// Claude Code's stream as BrainEvents. Text and thinking stream from stream_event deltas (which
// need includePartialMessages); a tool's call and result come from the whole assistant and user
// frames that follow them.

export const MCP_PREFIX = "mcp__auni__";

interface EventState {
  /** Block indexes restart with each model call, so each call is numbered to keep ids unique. */
  readonly call: number;
  readonly blocks: ReadonlyMap<number, { readonly kind: "text" | "thinking"; readonly id: string }>;
  /** It thinks on Auni's own API key, which no login fixes when it's refused. */
  readonly onAunisKey: boolean;
}

export const START: EventState = { call: 0, blocks: new Map(), onAunisKey: false };

/** What check would have said, when the API refused this turn's credential. */
function refused(state: EventState): BrainEvent {
  return state.onAunisKey
    ? {
        type: "refused",
        why: "broken",
        fix:
          "Anthropic refused AUNI_ANTHROPIC_API_KEY: put a working key in ~/.auni/.env, or " +
          "remove it to think on your Claude login, then restart Auni",
      }
    : { type: "refused", why: "signed-out", fix: "claude auth login" };
}

interface ContentBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

/**
 * The credential the CLI thinks on, as its apiKeySource names it: the owner's own login, or an
 * Anthropic API key, which bills every token. Only Auni's own key is in the CLI's environment, so
 * ANTHROPIC_API_KEY is that one; "/login managed key" is a key an Anthropic Console login made.
 */
export function loginOf(apiKeySource: string): string {
  if (apiKeySource === "none") return "your Claude login";
  if (apiKeySource === "ANTHROPIC_API_KEY") return "Auni's Anthropic API key";
  if (apiKeySource === "/login managed key") return "an Anthropic API key, from your Console login";
  return `an Anthropic API key, from ${apiKeySource}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part ? String(part.text) : "",
    )
    .filter(Boolean)
    .join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An MCP tool's structured result, which the SDK hands back beside its text; undefined when
 * there is none (the CLI's own tools, a text-only result).
 */
function structuredOf(toolUseResult: unknown): Record<string, unknown> | undefined {
  if (!isRecord(toolUseResult)) return undefined;
  return isRecord(toolUseResult.structuredContent) ? toolUseResult.structuredContent : undefined;
}

function fromStreamEvent(
  event: { readonly type: string; readonly [key: string]: unknown },
  state: EventState,
): { events: BrainEvent[]; state: EventState } {
  const index = event.index as number;
  if (event.type === "message_start")
    return { events: [], state: { ...state, call: state.call + 1, blocks: new Map() } };
  if (event.type === "content_block_start") {
    const kind = (event.content_block as ContentBlock).type;
    if (kind !== "text" && kind !== "thinking") return { events: [], state };
    const blocks = new Map(state.blocks).set(index, { kind, id: `${kind}-${state.call}-${index}` });
    return { events: [], state: { ...state, blocks } };
  }
  if (event.type === "content_block_delta") {
    const block = state.blocks.get(index);
    const delta = event.delta as {
      readonly type: string;
      readonly text?: string;
      readonly thinking?: string;
    };
    if (block?.kind === "text" && delta.type === "text_delta" && delta.text)
      return { events: [{ type: "text", id: block.id, delta: delta.text }], state };
    if (block?.kind === "thinking" && delta.type === "thinking_delta" && delta.thinking)
      return { events: [{ type: "thinking", id: block.id, delta: delta.thinking }], state };
  }
  return { events: [], state };
}

/** Pure: the same (frame, state) always gives the same (events, state). */
export function sdkEvents(
  message: SDKMessage,
  state: EventState = START,
): { events: BrainEvent[]; state: EventState } {
  // A subagent's frames reuse block indexes and aren't the answer.
  if ("parent_tool_use_id" in message && message.parent_tool_use_id) return { events: [], state };
  switch (message.type) {
    case "system":
      return message.subtype === "init"
        ? {
            events: [{ type: "ready", model: message.model, login: loginOf(message.apiKeySource) }],
            state: { ...state, onAunisKey: message.apiKeySource === "ANTHROPIC_API_KEY" },
          }
        : { events: [], state };
    case "stream_event":
      return fromStreamEvent(message.event as { type: string }, state);
    case "assistant": {
      // A credential the API refused comes back as a stand-in message carrying why.
      if (message.error === "authentication_failed") return { events: [refused(state)], state };
      const blocks = (message.message.content ?? []) as ContentBlock[];
      return {
        events: blocks
          .filter((block) => block.type === "tool_use")
          .map((block) => ({
            type: "tool-call",
            id: block.id!,
            name: block.name!.startsWith(MCP_PREFIX)
              ? block.name!.slice(MCP_PREFIX.length)
              : block.name!,
            input: block.input,
          })),
        state,
      };
    }
    case "user": {
      const content = message.message.content;
      if (!Array.isArray(content)) return { events: [], state };
      const structured = structuredOf(message.tool_use_result);
      return {
        events: (content as ContentBlock[])
          .filter((block) => block.type === "tool_result")
          .map((block) => ({
            type: "tool-result",
            id: block.tool_use_id!,
            output: structured ?? textOf(block.content),
            isError: block.is_error === true,
          })),
        state,
      };
    }
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      // Past its plan's window, a login with extra usage turned on carries on, paying for it.
      const carriesOn =
        info.isUsingOverage === true ||
        info.overageStatus === "allowed" ||
        info.overageStatus === "allowed_warning";
      if (info.status !== "rejected" || carriesOn) return { events: [], state };
      return {
        events: [
          { type: "limit", resetsAt: info.resetsAt ? new Date(info.resetsAt * 1_000) : null },
        ],
        state,
      };
    }
    case "result": {
      if (message.subtype === "success" && !message.is_error)
        return {
          events: [
            message.structured_output === undefined
              ? { type: "done" }
              : { type: "done", output: message.structured_output },
          ],
          state,
        };
      // A success that is an error carries the API's error as its text; the error subtypes list theirs.
      const detail =
        message.subtype === "success"
          ? message.result
          : `${message.subtype}: ${message.errors.join("; ")}`;
      return {
        events: [
          { type: "error", message: detail.trim().slice(0, 2_000) || "Claude Code failed." },
        ],
        state,
      };
    }
    default:
      return { events: [], state };
  }
}
