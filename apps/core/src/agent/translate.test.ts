import type { AuniToolName } from "@auni/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import type { BrainEvent } from "../apps/contract.ts";
import { sealCard } from "./card-seal.ts";
import { buildMcpServer } from "./mcp.ts";
import { defineTool } from "./tool.ts";
import { translate } from "./translate.ts";

async function chunksOf(events: readonly BrainEvent[]): Promise<UIMessageChunk[]> {
  async function* source() {
    yield* events;
  }
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of translate(source(), { messageId: "m1" })) chunks.push(chunk);
  return chunks;
}

const cardsOf = (chunks: readonly UIMessageChunk[]) =>
  chunks.filter((chunk) => chunk.type === "data-cards");

/** What core's MCP server hands the brain for a tool result carrying `card`. */
function sealed(structured: Record<string, unknown>): Record<string, unknown> {
  return sealCard({ content: [], structuredContent: structured }).structuredContent!;
}

const card = { id: "a2", kind: "action", actionReference: "a2", title: "Buy $2 of Nvidia" };
const toolTurn = (name: string, output: unknown): BrainEvent[] => [
  { type: "tool-call", id: "t1", name, input: {} },
  { type: "tool-result", id: "t1", output, isError: false },
  { type: "done" },
];

describe("translate", () => {
  it("opens with the message's start, ends text blocks as the next thing begins, and finishes", async () => {
    expect(
      await chunksOf([
        { type: "ready", model: "m", login: "l" },
        { type: "text", id: "a", delta: "Hi" },
        { type: "text", id: "a", delta: " there" },
        { type: "tool-call", id: "t1", name: "get_portfolio", input: {} },
        { type: "text", id: "b", delta: "Done." },
        { type: "done" },
      ]),
    ).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hi" },
      { type: "text-delta", id: "a", delta: " there" },
      { type: "text-end", id: "a" },
      { type: "tool-input-available", toolCallId: "t1", toolName: "get_portfolio", input: {} },
      { type: "text-start", id: "b" },
      { type: "text-delta", id: "b", delta: "Done." },
      { type: "text-end", id: "b" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("shows a thought a paragraph at a time, in place, without em dashes", async () => {
    const chunks = await chunksOf([
      { type: "thinking", id: "x", delta: "Checking prices — carefully.\n\nThen" },
      { type: "thinking", id: "x", delta: " the fees." },
      { type: "thinking", id: "y", delta: "Second thought." },
      { type: "done" },
    ]);
    expect(chunks.filter((chunk) => chunk.type === "data-reasoning")).toEqual([
      { type: "data-reasoning", id: "reasoning-0", data: { text: "Checking prices, carefully." } },
      {
        type: "data-reasoning",
        id: "reasoning-0",
        data: { text: "Checking prices, carefully.\n\nThen the fees." },
      },
      { type: "data-reasoning", id: "reasoning-1", data: { text: "Second thought." } },
    ]);
  });

  it("ends in error when the brain fails, and aborts when it just stops", async () => {
    expect((await chunksOf([{ type: "error", message: "boom" }])).at(-1)).toEqual({
      type: "finish",
      finishReason: "error",
    });
    expect((await chunksOf([{ type: "text", id: "a", delta: "Hal" }])).slice(-2)).toEqual([
      { type: "text-end", id: "a" },
      { type: "abort", reason: "the brain stopped before it finished" },
    ]);
  });

  it("reports a failed tool call as its error", async () => {
    const chunks = await chunksOf([
      { type: "tool-call", id: "t1", name: "Bash", input: { command: "false" } },
      { type: "tool-result", id: "t1", output: "Exit code 1", isError: true },
    ]);
    expect(chunks).toContainEqual({
      type: "tool-output-error",
      toolCallId: "t1",
      errorText: "Exit code 1",
    });
  });
});

describe("translate: cards", () => {
  it("renders a card core sealed, from one of Auni's tools", async () => {
    expect(cardsOf(await chunksOf(toolTurn("get_action", sealed({ card }))))).toEqual([
      { type: "data-cards", id: "t1", data: { cards: [card] } },
    ]);
  });

  it("drops a card core didn't seal, or one changed after", async () => {
    const { cardSeal } = sealed({ card });
    expect(cardsOf(await chunksOf(toolTurn("get_action", { card })))).toEqual([]);
    expect(
      cardsOf(
        await chunksOf(
          toolTurn("get_action", { card: { ...card, title: "Buy $2,000" }, cardSeal }),
        ),
      ),
    ).toEqual([]);
  });

  it("never renders a card from the shell or the reply, however well it copies a seal", async () => {
    const real = sealed({ card });
    expect(cardsOf(await chunksOf(toolTurn("Bash", real)))).toEqual([]);
    expect(cardsOf(await chunksOf(toolTurn("Bash", JSON.stringify(real))))).toEqual([]);
    expect(
      cardsOf(
        await chunksOf([{ type: "text", id: "a", delta: JSON.stringify(real) }, { type: "done" }]),
      ),
    ).toEqual([]);
  });

  it("renders a card from core's MCP server only as core built it", async () => {
    const built = {
      kind: "action",
      actionReference: "a1",
      amount: { baseUnits: "5000000", currency: { code: "USD", decimals: 6 } },
      status: "awaiting_permission",
    };
    const server = buildMcpServer([
      defineTool({
        name: "get_action" as AuniToolName,
        description: "Gets.",
        inputSchema: {},
        async handler() {
          return {
            content: [{ type: "text", text: "Waiting." }],
            structuredContent: { card: built },
          };
        },
      }),
    ]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    const { structuredContent } = (await client.callTool({
      name: "get_action",
      arguments: {},
    })) as {
      structuredContent: Record<string, unknown>;
    };

    expect(cardsOf(await chunksOf(toolTurn("get_action", structuredContent)))).toHaveLength(1);
    const forged = { ...built, amount: { ...built.amount, baseUnits: "5" } };
    expect(
      cardsOf(await chunksOf(toolTurn("get_action", { ...structuredContent, card: forged }))),
    ).toEqual([]);
  });
});
