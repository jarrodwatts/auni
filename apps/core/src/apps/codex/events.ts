import type { BrainEvent } from "../contract.ts";
import type { RpcMessage } from "./app-server.ts";

// Codex's notifications as BrainEvents, pinned to codex-cli 0.164.0's app-server protocol
// (`codex app-server generate-ts --experimental`). Text and thinking stream as deltas; a tool's
// call and result come from its item starting and completing.

interface Window {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

/** The latest of the plan's usage windows, as rate-limit updates fill them in. */
interface Limits {
  readonly primary: Window | null;
  readonly secondary: Window | null;
}

interface EventState {
  /** This turn's thread: anything from another (a subagent's) isn't the answer. */
  readonly threadId: string;
  /** Set when the turn asked for an answer in a JSON Schema's shape. */
  readonly structured: boolean;
  readonly limits: Limits | null;
  /** Messages that streamed deltas, so their completion doesn't repeat them. */
  readonly streamed: ReadonlySet<string>;
  /** The newest finished message, which is the answer a schema asked for. */
  readonly lastMessage: string | null;
  readonly limited: boolean;
}

export function startState(threadId: string, structured: boolean): EventState {
  return {
    threadId,
    structured,
    limits: null,
    streamed: new Set(),
    lastMessage: null,
    limited: false,
  };
}

type Step = { readonly events: BrainEvent[]; readonly state: EventState };

type Item = { readonly type: string; readonly id: string; readonly [key: string]: unknown };

interface TurnError {
  readonly message: string;
  readonly codexErrorInfo: unknown;
}

const AUNI_SERVER = "auni";

/** What the owner runs to sign Codex in, as check and a refused turn both say it. */
export const LOGIN_FIX = "codex login --device-auth";

/** The plan is out of turns: its own error, not one Codex retries. */
export function isUsageLimit(message: RpcMessage): boolean {
  if (message.method !== "error") return false;
  const params = message.params as { readonly error: TurnError; readonly willRetry: boolean };
  return !params.willRetry && params.error.codexErrorInfo === "usageLimitExceeded";
}

/** When the plan comes back: the latest reset among the windows it has used up. */
function resetsAt(limits: Limits | null): Date | null {
  const full = [limits?.primary, limits?.secondary].filter(
    (window): window is Window => !!window && window.usedPercent >= 100 && !!window.resetsAt,
  );
  if (full.length === 0) return null;
  return new Date(Math.max(...full.map((window) => window.resetsAt!)) * 1_000);
}

/** A web search or page read, as the web shows it: WebSearch {query} or WebFetch {url}. */
function webTool(item: Item): { name: string; input: Record<string, unknown> } {
  const action = item.action as { type: string; url?: string | null } | null;
  if (action && (action.type === "openPage" || action.type === "findInPage"))
    return { name: "WebFetch", input: { url: action.url ?? "" } };
  return { name: "WebSearch", input: { query: item.query } };
}

function mcpToolName(item: Item): string {
  return item.server === AUNI_SERVER
    ? String(item.tool)
    : `mcp__${String(item.server)}__${String(item.tool)}`;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part ? String(part.text) : "",
    )
    .filter(Boolean)
    .join("\n");
}

function started(item: Item): BrainEvent[] {
  if (item.type === "mcpToolCall")
    return [{ type: "tool-call", id: item.id, name: mcpToolName(item), input: item.arguments }];
  if (item.type === "commandExecution")
    return [{ type: "tool-call", id: item.id, name: "Bash", input: { command: item.command } }];
  // A web search says what it looked for only once it's done.
  return [];
}

function completed(item: Item, state: EventState): Step {
  switch (item.type) {
    case "mcpToolCall": {
      const result = item.result as { content: unknown; structuredContent: unknown } | null;
      const error = item.error as { message: string } | null;
      return {
        events: [
          {
            type: "tool-result",
            id: item.id,
            output: error ? error.message : (result?.structuredContent ?? textOf(result?.content)),
            isError: !!error || item.status === "failed",
          },
        ],
        state,
      };
    }
    case "commandExecution":
      return {
        events: [
          {
            type: "tool-result",
            id: item.id,
            output: item.aggregatedOutput ?? "",
            isError: item.status !== "completed",
          },
        ],
        state,
      };
    case "webSearch": {
      const { name, input } = webTool(item);
      return {
        events: [
          { type: "tool-call", id: item.id, name, input },
          { type: "tool-result", id: item.id, output: "", isError: false },
        ],
        state,
      };
    }
    case "agentMessage": {
      const text = String(item.text ?? "");
      const next = { ...state, lastMessage: text };
      // Every message streams its deltas first; one that somehow didn't still gets shown.
      return state.streamed.has(item.id) || !text
        ? { events: [], state: next }
        : { events: [{ type: "text", id: item.id, delta: text }], state: next };
    }
    default:
      return { events: [], state };
  }
}

function finished(turn: { status: string; error: TurnError | null }, state: EventState): Step {
  if (turn.status === "completed") {
    if (!state.structured) return { events: [{ type: "done" }], state };
    try {
      return { events: [{ type: "done", output: JSON.parse(state.lastMessage ?? "") }], state };
    } catch {
      return {
        events: [{ type: "error", message: "Codex's answer wasn't the JSON asked for." }],
        state,
      };
    }
  }
  const message =
    turn.error?.message.trim().slice(0, 2_000) ||
    (turn.status === "interrupted" ? "Codex was stopped." : "Codex failed.");
  // Its login was refused: signed out, or a token that expired.
  const refused: BrainEvent[] =
    turn.error?.codexErrorInfo === "unauthorized"
      ? [{ type: "refused", why: "signed-out", fix: LOGIN_FIX }]
      : [];
  return { events: [...refused, { type: "error", message }], state };
}

/** Pure: the same (notification, state) always gives the same (events, state). */
export function codexEvents(message: RpcMessage, state: EventState): Step {
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (params.threadId !== undefined && params.threadId !== state.threadId)
    return { events: [], state };
  switch (message.method) {
    case "item/agentMessage/delta": {
      const id = String(params.itemId);
      const streamed = state.streamed.has(id) ? state.streamed : new Set(state.streamed).add(id);
      return {
        events: [{ type: "text", id, delta: String(params.delta) }],
        state: { ...state, streamed },
      };
    }
    case "item/reasoning/summaryTextDelta":
      return {
        events: [
          {
            type: "thinking",
            id: `${String(params.itemId)}:${String(params.summaryIndex)}`,
            delta: String(params.delta),
          },
        ],
        state,
      };
    case "item/started":
      return { events: started(params.item as Item), state };
    case "item/completed":
      return completed(params.item as Item, state);
    case "account/rateLimits/updated": {
      // Updates are sparse: a window left out keeps what it was.
      const update = params.rateLimits as Partial<Limits>;
      const limits = {
        primary: update.primary ?? state.limits?.primary ?? null,
        secondary: update.secondary ?? state.limits?.secondary ?? null,
      };
      return { events: [], state: { ...state, limits } };
    }
    case "error":
      return isUsageLimit(message) && !state.limited
        ? {
            events: [{ type: "limit", resetsAt: resetsAt(state.limits) }],
            state: { ...state, limited: true },
          }
        : { events: [], state };
    case "turn/completed":
      return finished(params.turn as { status: string; error: TurnError | null }, state);
    default:
      return { events: [], state };
  }
}
