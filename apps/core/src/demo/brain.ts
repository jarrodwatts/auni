import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { Brain, BrainEvent, BrainTurn } from "../apps/contract.ts";
import { sceneFor } from "./scenes.ts";
import { demoPoints } from "./points.ts";
import { tour } from "./tour.ts";

// The demo's brain: a brain app like any other (apps/brain.md) that needs no login and
// calls no model. It answers from a script (scenes.ts), and otherwise does what a real brain
// does: it streams its thinking and its words as events, and calls Auni's real tools over
// core's MCP server with the turn's own token, so every card it shows is one core made and
// sealed. What it is told is the same prompt a real brain gets, and it reads what woke the
// turn out of it.

/** How long the brain waits between the words it streams; the seed sets none (demo/seed.ts). */
const pace = { wordMs: 18 };

/** Has the brain stream at once, or at a person's reading speed again. */
export function setPace(wordMs: number): void {
  pace.wordMs = wordMs;
}

/** What a scene has to work with: what woke the turn, and the three things a brain can do. */
export interface Stage {
  /** The owner's message, or the background event that woke the turn, in core's own words. */
  readonly heard: string;
  /** The thread before this turn, a block a message, as core tells it to any brain. */
  readonly before: readonly string[];
  /** What core told the turn beside it (the cards waiting, say), in core's own words. */
  readonly context: string;
  /** Thinks out loud: shown as the brain's reasoning. */
  think(text: string): AsyncGenerator<BrainEvent, void>;
  /** Says something to the owner, streamed word by word. */
  say(text: string): AsyncGenerator<BrainEvent, void>;
  /**
   * Calls one of Auni's tools, as a real brain does, and gives back the words it answered, which
   * are what a brain reads. A tool that refuses ends the scene, since what the scene says next
   * takes the call to have worked.
   */
  call(name: string, input: Record<string, unknown>): AsyncGenerator<BrainEvent, string>;
}

/** A tool refused the call a scene made: the scene ends, and the brain says what Auni answered. */
class Refused extends Error {}

/** What woke the turn: the last thing in its prompt, after the context core put before it. */
function heardIn(turn: BrainTurn): string {
  const last = turn.prompt.at(-1) ?? "";
  const after = last.lastIndexOf("</system-reminder>");
  return (after < 0 ? last : last.slice(after + "</system-reminder>".length)).trim();
}

/** What core put before what woke the turn: the turn's context. */
function contextIn(turn: BrainTurn): string {
  const last = turn.prompt.at(-1) ?? "";
  return last.slice(0, Math.max(0, last.lastIndexOf("</system-reminder>")));
}

/** The thread before the turn, a block a message, without the wrapper core puts around them. */
function beforeIn(turn: BrainTurn): string[] {
  return turn.prompt
    .slice(0, -1)
    .map((block) => block.replace(/^<conversation_so_far>\n/u, "").trim());
}

/**
 * Plays the scene for what the stage heard, and says whether it played to its end: where a
 * tool refused, the brain says what Auni answered instead of the scene's own words.
 */
async function* scene(stage: Stage): AsyncGenerator<BrainEvent, boolean> {
  try {
    yield* sceneFor(stage.heard).play(stage);
    return true;
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    yield* stage.say(
      `Auni wouldn't make that card here, so there is nothing to tap. It said: ${error.message}`,
    );
    return false;
  }
}

async function* run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent> {
  yield { type: "ready", model: "a script", login: "the demo, which needs no login" };
  // A question with no tools (a login's proof, triage, a new chat's starting points). The demo
  // has a view on one, where a new chat starts: its tour comes first (points.ts). Each asker
  // falls back to its own answer when given none.
  if (!turn.mcp) {
    const points = /starting points/u.test(turn.systemPrompt);
    yield { type: "done", output: points ? demoPoints(turn.prompt) : {} };
    return;
  }

  const tools = new Client({ name: "auni-demo-brain", version: "1.0.0" });
  let ids = 0;
  const id = (kind: string) => `${kind}-${++ids}`;
  async function* stream(type: "text" | "thinking", text: string): AsyncGenerator<BrainEvent> {
    const block = id(type);
    for (const word of text.match(/\S+\s*/gu) ?? []) {
      if (signal.aborted) return;
      if (pace.wordMs > 0) await sleep(pace.wordMs);
      yield { type, id: block, delta: word };
    }
  }
  const stage: Stage = {
    heard: heardIn(turn),
    before: beforeIn(turn),
    context: contextIn(turn),
    think: (text) => stream("thinking", text),
    say: (text) => stream("text", `${text}\n\n`),
    async *call(name, input) {
      const call = id("call");
      yield { type: "tool-call", id: call, name, input };
      const answer = await tools.callTool({ name, arguments: input }).then(
        (result) => ({
          output: result.structuredContent ?? textOf(result.content),
          read: textOf(result.content),
          failed: result.isError === true,
        }),
        (error: unknown) => ({ output: String(error), read: String(error), failed: true }),
      );
      yield { type: "tool-result", id: call, output: answer.output, isError: answer.failed };
      if (answer.failed) {
        console.warn(`The demo's brain called ${name}, which refused: ${String(answer.output)}`);
        throw new Refused(String(answer.output));
      }
      return answer.read;
    },
  };

  try {
    await tools.connect(
      new StreamableHTTPClientTransport(new URL(turn.mcp.url), {
        requestInit: { headers: { authorization: `Bearer ${turn.mcp.token}` } },
      }),
    );
    yield* tour(stage, scene);
    yield { type: "done" };
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    await tools.close().catch(() => {});
  }
}

function textOf(content: unknown): string {
  return (content as { type: string; text?: string }[])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

export const demoBrain: Brain = {
  check: async () => ({ ready: true, login: "the demo, which needs no login" }),
  run,
  // It has no login, so there is nothing of its own for a box to hide.
  secrets: () => [],
  // No CLI to open in a terminal: `auni triage` is for an Auni of the owner's own.
  terminal: () => null,
  computer: "no computer: the demo's brain is a script",
  models: "no model: the demo's answers are scripted",
};
