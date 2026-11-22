import { AUNI_TOOL_NAMES, type AuniToolName } from "@auni/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ThreadRow } from "../db/schema.ts";
import { serve } from "../test/serve.ts";
import { buildMcpServer, mcpRouter, toolsFor } from "./mcp.ts";
import { suggestRepliesTool } from "./replies.ts";
import { defineTool } from "./tool.ts";

const url = serve(express().use(mcpRouter));

describe("core MCP server", () => {
  it("registers exactly the tools web knows by name", () => {
    const thread = { id: "t", specialistId: null } as ThreadRow;
    process.env.ELFA_AUTO_API_KEY = "elfa-test";
    try {
      const names = toolsFor({ thread }).map((tool) => tool.name);
      expect(names.toSorted()).toEqual([...AUNI_TOOL_NAMES].toSorted());
    } finally {
      delete process.env.ELFA_AUTO_API_KEY;
    }
  });

  it("leaves out the market tools without an Elfa key, so the agent never calls one that can't answer", () => {
    const thread = { id: "t", specialistId: null } as ThreadRow;
    const names = toolsFor({ thread }).map((tool) => tool.name);
    expect(names).not.toContain("market_pulse");
    expect(names).not.toContain("market_news");
  });

  it("carries a card tool's text inside structuredContent, where the Agent SDK shows it to Claude", async () => {
    const server = buildMcpServer([
      defineTool({
        name: "show_card" as AuniToolName,
        description: "Shows a card.",
        inputSchema: {},
        async handler() {
          return {
            content: [{ type: "text", text: "Shown. Write nothing more." }],
            structuredContent: { card: { kind: "replies" } },
          };
        },
      }),
    ]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const result = await client.callTool({ name: "show_card", arguments: {} });

    expect(result.structuredContent).toEqual({
      message: "Shown. Write nothing more.",
      card: { kind: "replies" },
      cardSeal: expect.any(String),
    });
  });

  it("runs what must come before a tool before the tool, on each call", async () => {
    const order: string[] = [];
    const server = buildMcpServer(
      [
        defineTool({
          name: "act" as AuniToolName,
          description: "Acts.",
          inputSchema: {},
          async handler() {
            order.push("tool");
            return { content: [{ type: "text", text: "Done." }] };
          },
        }),
      ],
      async () => void order.push("before"),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    await client.listTools();
    expect(order).toEqual([]);
    await client.callTool({ name: "act", arguments: {} });
    await client.callTool({ name: "act", arguments: {} });
    expect(order).toEqual(["before", "tool", "before", "tool"]);
  });

  it("takes a list the agent sent as a JSON string, as it sometimes does", async () => {
    const server = buildMcpServer([suggestRepliesTool({ threadId: "no-turn" })]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const result = await client.callTool({
      name: "suggest_replies",
      arguments: {
        question: "Where should the money go?",
        options: JSON.stringify([{ label: "Keep it as cash" }, { label: "Put it in savings" }]),
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          /^Asked: Where should the money go\? Options: Keep it as cash \/ Put it in savings\. /,
        ),
      },
    ]);
  });

  it("offers replies with no question, and refuses a question with one answer", async () => {
    const server = buildMcpServer([suggestRepliesTool({ threadId: "no-turn" })]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const offered = await client.callTool({
      name: "suggest_replies",
      arguments: { options: [{ label: "Show me the plan" }] },
    });
    expect(offered.isError).toBeFalsy();
    expect(offered.content).toEqual([
      { type: "text", text: expect.stringMatching(/^Offered: Show me the plan\. /) },
    ]);
    const asked = await client.callTool({
      name: "suggest_replies",
      arguments: { question: "Go ahead?", options: [{ label: "Yes" }] },
    });
    expect(asked.isError).toBe(true);
  });

  it("refuses a call too large to be real before validating it, so it can't run core out of memory", async () => {
    let ran = false;
    const server = buildMcpServer([
      defineTool({
        name: "take_list" as AuniToolName,
        description: "Takes a list.",
        inputSchema: { items: z.array(z.object({ id: z.string() })).max(12) },
        async handler() {
          ran = true;
          return { content: [{ type: "text", text: "Taken." }] };
        },
      }),
    ]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const result = await client.callTool({
      name: "take_list",
      arguments: { items: Array.from({ length: 5_000 }, () => ({})) },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("more than the maximum");
    expect(ran).toBe(false);
  });

  // A live Polymarket buy sent its dollars as text and was refused with zod's bare words. Text
  // that plainly means a number is now read as one (tool.test.ts); what's left is said plainly.
  it("says plainly what a money tool's call got wrong, so the agent can send it again", async () => {
    const thread = { id: "t", specialistId: null } as ThreadRow;
    const server = buildMcpServer(toolsFor({ thread }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    const said = async (name: string, args: Record<string, unknown>) =>
      JSON.stringify((await client.callTool({ name, arguments: args })).content);

    expect(
      await said("polymarket_order", {
        market: "x",
        outcome: "Yes",
        side: "buy",
        amountUsd: "1.5 dollars",
      }),
    ).toContain('amountUsd must be a number, and it was sent as text (\\"1.5 dollars\\")');
    expect(await said("update_specialist", { retired: "yes" })).toContain(
      'retired must be true, without quotes, and it was sent as text (\\"yes\\")',
    );
    const swap = await said("evm_swap", { chain: "mars", sellToken: 5, amountUsd: 20 });
    expect(swap).toContain(
      'chain must be one of \\"monad\\", \\"base\\", \\"arbitrum\\", \\"polygon\\", and it was sent as text (\\"mars\\")',
    );
    expect(swap).toContain("sellToken must be text, and it was sent as the number 5");
    expect(swap).toContain("buyToken is missing: it must be given, as text");
  });

  it("rejects a request without the per-turn token before any tool runs", async () => {
    const response = await fetch(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
