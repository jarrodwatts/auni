import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { BrainEvent, BrainTurn } from "../contract.ts";
import { answerTo, type AppServer, type RpcMessage, type WireLine } from "./app-server.ts";
import { runCodex } from "./run.ts";

const recorded = readFileSync(new URL("fixtures/card.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as WireLine);

/**
 * The recorded app-server: each request gets the answer the real one gave, and the turn's
 * notifications follow its start. Later turns get `followUps`, one list each.
 */
function replay(followUps: RpcMessage[][] = []): {
  server: AppServer;
  asked: { method: string; params: unknown }[];
} {
  const answers = new Map<string, unknown>();
  for (const line of recorded) {
    if (line.from !== "core" || !line.message.method) continue;
    const reply = recorded.find(
      (other) =>
        other.from === "codex" && !other.message.method && other.message.id === line.message.id,
    );
    answers.set(line.message.method, reply?.message.result);
  }
  const notifications = recorded
    .filter((line) => line.from === "codex" && line.message.method && line.message.id === undefined)
    .map((line) => line.message);
  const queue: RpcMessage[] = [];
  const asked: { method: string; params: unknown }[] = [];
  let turns = 0;
  const server: AppServer = {
    request<Result>(method: string, params: unknown) {
      asked.push({ method, params });
      if (method === "turn/start")
        queue.push(...(turns++ === 0 ? notifications : (followUps.shift() ?? [])));
      return Promise.resolve(answers.get(method) as Result);
    },
    notify: () => {},
    next: () => Promise.resolve(queue.shift() ?? null),
    ended: "replay over",
    close: () => {},
  };
  return { server, asked };
}

const turn: BrainTurn = {
  systemPrompt: "You are Auni.",
  prompt: ["history", "Sam: where do I send $20 on Base?"],
  role: "deep",
  box: { workDir: "/tmp/auni-live/work", hidden: [], readable: [] },
  mcp: { url: "http://127.0.0.1:4517/mcp", token: "turn-token" },
};

async function collect(events: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const all: BrainEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const threadId = "01a1ab93-3c4a-7b81-b701-d9e486c436c7";
const reply: RpcMessage[] = [
  {
    method: "item/agentMessage/delta",
    params: { threadId, itemId: "m2", delta: "Your Base address is on the card." },
  },
  { method: "turn/completed", params: { threadId, turn: { status: "completed", error: null } } },
];

describe("a Codex turn, replayed", () => {
  it("starts one ephemeral thread on Auni's prompt, with the owner's own MCP servers off", async () => {
    const { server, asked } = replay([reply]);
    await collect(runCodex(turn, new AbortController().signal, { start: () => server }));
    expect(asked.map((call) => call.method).slice(0, 6)).toEqual([
      "initialize",
      "config/read",
      "account/read",
      "model/list",
      "thread/start",
      "turn/start",
    ]);
    expect(asked.find((call) => call.method === "thread/start")?.params).toEqual({
      model: "gpt-6.1-sol",
      cwd: turn.box.workDir,
      approvalPolicy: "never",
      permissions: "auni",
      baseInstructions: "You are Auni.",
      ephemeral: true,
      config: { "mcp_servers.railway.enabled": false },
    });
    expect(asked.find((call) => call.method === "turn/start")?.params).toMatchObject({
      input: [{ type: "text", text: "history\n\nSam: where do I send $20 on Base?" }],
      effort: "high",
    });
  });

  it("says it's ready on the owner's plan, shows the card, and gets a reply after an empty answer", async () => {
    const { server, asked } = replay([reply]);
    const events = await collect(
      runCodex(turn, new AbortController().signal, { start: () => server }),
    );
    expect(events[0]).toEqual({
      type: "ready",
      model: "gpt-6.1-sol",
      login: "your ChatGPT Pro plan",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-call", name: "wait_for_deposit" }),
    );
    // The recorded turn ended on an empty answer, so Codex was asked once more for the reply.
    expect(asked.filter((call) => call.method === "turn/start")).toHaveLength(2);
    expect(events.slice(-2)).toEqual([
      { type: "text", id: "m2", delta: "Your Base address is on the card." },
      { type: "done" },
    ]);
  });

  it("ends in an error when the app-server stops mid-turn", async () => {
    const { server } = replay([]);
    const events = await collect(
      runCodex(turn, new AbortController().signal, { start: () => server }),
    );
    expect(events.at(-1)).toEqual({ type: "error", message: "replay over" });
  });

  it("says plainly when Codex isn't there to start", async () => {
    const events = await collect(
      runCodex(turn, new AbortController().signal, {
        start: () => {
          throw new Error("Codex isn't installed here: npm install -g @openai/codex");
        },
      }),
    );
    expect(events).toEqual([
      { type: "error", message: "Codex isn't installed here: npm install -g @openai/codex" },
    ]);
  });
});

describe("what core answers Codex", () => {
  it("declines every approval and question, and has no other method", () => {
    expect(answerTo("item/commandExecution/requestApproval")).toEqual({
      result: { decision: "decline" },
    });
    expect(answerTo("item/fileChange/requestApproval")).toEqual({
      result: { decision: "decline" },
    });
    expect(answerTo("mcpServer/elicitation/request")).toEqual({
      result: { action: "decline", content: null, _meta: null },
    });
    for (const method of [
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
      "item/tool/call",
    ])
      expect(answerTo(method).error?.code).toBe(-32601);
  });
});
