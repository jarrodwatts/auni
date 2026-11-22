import type { BrainEvent, BrainTurn } from "../contract.ts";
import { startAppServer, type AppServer, type RpcMessage, type WireLine } from "./app-server.ts";
import { account, defaultModel, hello, loginOf } from "./check.ts";
import { codexEvents, isUsageLimit, LOGIN_FIX, startState } from "./events.ts";
import {
  childEnv,
  codexArgs,
  codexCommand,
  codexInstall,
  effortFor,
  INSTALL_FIX,
} from "./options.ts";

/** After asking a stopped turn to end, how long it gets before the process is killed. */
const STOP_GRACE_MS = 2_000;

/**
 * The owner's own MCP servers stay out of Auni's turns: the thread's config switches off every
 * server but Auni's (on this machine, a deploy tool's).
 */
async function othersOff(server: AppServer): Promise<Record<string, false>> {
  const { config } = await server.request<{
    config: { mcp_servers?: Record<string, unknown> | null };
  }>("config/read", {});
  return Object.fromEntries(
    Object.keys(config.mcp_servers ?? {})
      .filter((id) => id !== "auni")
      .map((id) => [`mcp_servers.${id}.enabled`, false]),
  );
}

let warnedInstructions = false;

/**
 * Codex always adds the owner's own instructions file (CODEX_HOME/AGENTS.md) to a thread, with
 * no setting to leave it out while keeping their login (openai/codex#55157). It's their own
 * text, so it's no danger, but it was written for their coding, so say so once.
 */
function noteInstructions(sources: readonly string[]): void {
  if (sources.length === 0 || warnedInstructions) return;
  warnedInstructions = true;
  console.warn(
    `Codex adds your own instructions (${sources.join(", ")}) to Auni's turns. To keep them out, run Auni with CODEX_HOME set to a Codex home of its own, logged in with: ${LOGIN_FIX}`,
  );
}

/**
 * Codex sometimes ends a turn on an empty answer once a tool's card is up (a real turn did,
 * fixtures/card.jsonl). The person sees only the reply and its cards, so it gets one more go.
 */
const NUDGE =
  "Nothing you wrote reached the owner: they see only your reply text and any cards. Write your reply now.";

/** Codex's app-server for this turn, in its box. */
function startFor(turn: BrainTurn, onLine?: (line: WireLine) => void): AppServer {
  const command = codexCommand();
  if (!command) throw new Error(`Codex isn't installed here: ${INSTALL_FIX}`);
  return startAppServer({
    command,
    args: codexArgs(turn, codexInstall(command)),
    env: childEnv(turn.mcp?.token ?? null),
    cwd: turn.box.workDir,
    onLine,
  });
}

interface RunOptions {
  /** Sees every line either way (record.ts keeps them). */
  readonly onLine?: (line: WireLine) => void;
  /** A recorded app-server stands in for the real one in tests. */
  readonly start?: typeof startFor;
}

const text = (value: string) => [{ type: "text", text: value, text_elements: [] }];

/**
 * One turn of the owner's own Codex on this machine, as BrainEvents, ending in exactly one done
 * or error unless it was stopped.
 */
export async function* runCodex(
  turn: BrainTurn,
  signal: AbortSignal,
  { onLine, start = startFor }: RunOptions = {},
): AsyncIterable<BrainEvent> {
  let server: AppServer;
  try {
    server = start(turn, onLine);
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
    return;
  }
  let threadId: string | null = null;
  let turnId: string | null = null;
  const stop = () => {
    if (threadId && turnId)
      void server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    setTimeout(() => server.close(), STOP_GRACE_MS).unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    await hello(server);
    const disabled = await othersOff(server);
    const owner = await account(server);
    if (!owner) throw new Error(`Codex isn't logged in here: ${LOGIN_FIX}`);
    const model = await defaultModel(server);
    if (!model) throw new Error("Codex offers this login no model.");
    const thread = await server.request<{
      thread: { id: string };
      model: string;
      instructionSources: string[];
    }>("thread/start", {
      model: model.model,
      cwd: turn.box.workDir,
      approvalPolicy: "never",
      permissions: "auni",
      baseInstructions: turn.systemPrompt,
      ephemeral: true,
      config: disabled,
    });
    threadId = thread.thread.id;
    noteInstructions(thread.instructionSources);
    if (signal.aborted) return;
    yield { type: "ready", model: thread.model, login: loginOf(owner) };

    const startTurn = async (input: string) => {
      const started = await server.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: text(input),
        effort: effortFor(turn.role, model),
        summary: "concise",
        ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
      });
      turnId = started.turn.id;
      if (signal.aborted) stop();
    };
    await startTurn(turn.prompt.join("\n\n"));

    let state = startState(threadId, turn.outputSchema !== undefined);
    let wrote = false;
    let nudged = turn.outputSchema !== undefined; // a schema's answer is the JSON, never a reply
    for (let message = await server.next(); message; message = await server.next()) {
      // A plan out of turns says when it comes back in its rate limits; ask if none came yet.
      if (isUsageLimit(message) && !state.limits) {
        const read = await server
          .request<{ rateLimits: unknown }>("account/rateLimits/read", {})
          .catch(() => null);
        if (read) state = codexEvents(rateLimits(read.rateLimits), state).state;
      }
      const step = codexEvents(message, state);
      state = step.state;
      for (const event of step.events) {
        if (signal.aborted) return;
        if (event.type === "text" && event.delta.trim()) wrote = true;
        if (event.type === "done" && !wrote && !nudged) {
          nudged = true;
          await startTurn(NUDGE);
          continue;
        }
        yield event;
        if (event.type === "done" || event.type === "error") return;
      }
    }
    if (!signal.aborted) throw new Error(server.ended ?? "Codex ended without finishing the turn.");
  } catch (error) {
    if (signal.aborted) return;
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    signal.removeEventListener("abort", stop);
    server.close();
  }
}

const rateLimits = (snapshot: unknown): RpcMessage => ({
  method: "account/rateLimits/updated",
  params: { rateLimits: snapshot },
});

export function run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent> {
  return runCodex(turn, signal);
}
