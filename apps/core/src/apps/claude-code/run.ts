import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  query,
  type HookCallbackMatcher,
  type HookEvent,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { egressPort } from "../../agent/egress.ts";
import { dataDir } from "../../data-dir.ts";
import type { BrainEvent, BrainTurn } from "../contract.ts";
import { loginOf, sdkEvents, START } from "./events.ts";
import { claudeOptions, mcpConfig } from "./options.ts";

const STDERR_TAIL_CHARS = 2_000;

/** The thread as one user message; history first, so the next turn can read it from the cache. */
async function* oneUserMessage(prompt: readonly string[]): AsyncIterable<SDKUserMessage> {
  const content = prompt.map((text) => ({ type: "text" as const, text }));
  // Every block but the last is history, which the next turn's prompt repeats unchanged: a cache
  // breakpoint at its end lets that turn read it back rather than write it all again. It lasts an
  // hour, as the CLI is told to make its own (promptCacheTtl in options.ts): the API refuses a
  // whole turn whose shorter breakpoint comes before a longer one.
  if (content.length > 1)
    Object.assign(content.at(-2)!, { cache_control: { type: "ephemeral", ttl: "1h" } });
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content } };
}

/**
 * The reply is the turn's visible text, and a question asked with suggest_replies shows under
 * it: a turn that asked can't end until some reply was written.
 */
function replyGuard(): {
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  saw(message: SDKMessage): void;
} {
  let asked = false;
  let wroteReply = false;
  return {
    saw(message) {
      const event = message.type === "stream_event" ? message.event : null;
      if (
        event?.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        event.delta.text.trim()
      )
        wroteReply = true;
    },
    hooks: {
      PostToolUse: [
        {
          matcher: "suggest_replies|mcp__auni__suggest_replies",
          hooks: [
            () => {
              asked = true;
              return Promise.resolve({});
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            (event) =>
              Promise.resolve(
                asked && !wroteReply && !("stop_hook_active" in event && event.stop_hook_active)
                  ? {
                      decision: "block" as const,
                      reason:
                        "Nothing you wrote reached the owner: they see only your reply text. Write it now: what you found, your honest take, and anything they need; the question you asked shows under it.",
                    }
                  : {},
              ),
          ],
        },
      ],
    },
  };
}

/**
 * Writes this turn's MCP config, readable by the owner alone, in the data folder the box hides
 * whole. Each turn's token is retired as the turn ends, so one left behind by a killed process
 * opens nothing.
 */
function writeMcpConfig(mcp: NonNullable<BrainTurn["mcp"]>): string {
  const dir = join(dataDir(), "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `mcp-${randomUUID()}.json`);
  writeFileSync(file, mcpConfig(mcp), { mode: 0o600, flag: "wx" });
  return file;
}

/** One turn of the owner's own Claude Code on this machine, as its raw frames. */
export async function* claudeFrames(
  turn: BrainTurn,
  signal: AbortSignal,
): AsyncIterable<SDKMessage> {
  const guard = replyGuard();
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let stderr = "";
  const configFile = turn.mcp ? writeMcpConfig(turn.mcp) : null;
  try {
    const options = {
      ...claudeOptions(turn, guard.hooks, abortController, await egressPort(), configFile),
      stderr: (data: string) => (stderr = (stderr + data).slice(-STDERR_TAIL_CHARS)),
    };
    for await (const message of query({ prompt: oneUserMessage(turn.prompt), options })) {
      guard.saw(message);
      yield message;
    }
  } catch (error) {
    if (signal.aborted) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude Code stopped: ${detail}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
  } finally {
    signal.removeEventListener("abort", abort);
    if (configFile) rmSync(configFile, { force: true });
  }
}

/** The turn as BrainEvents, ending in exactly one done or error unless it was stopped. */
export async function* run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent> {
  let state = START;
  try {
    for await (const frame of claudeFrames(turn, signal)) {
      // The login check saw the owner's plan, or Auni's own key; anything else bills every token.
      if (
        frame.type === "system" &&
        frame.subtype === "init" &&
        !["none", "ANTHROPIC_API_KEY"].includes(frame.apiKeySource)
      )
        console.warn(
          `Claude Code thinks on ${loginOf(frame.apiKeySource)} this turn, billed per token.`,
        );
      const step = sdkEvents(frame, state);
      state = step.state;
      for (const event of step.events) {
        yield event;
        if (event.type === "done" || event.type === "error") return;
      }
    }
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
    return;
  }
  if (!signal.aborted) yield { type: "error", message: "Claude Code ended without a result." };
}
