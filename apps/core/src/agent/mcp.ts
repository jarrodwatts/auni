import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import type { z, ZodRawShape } from "zod";

import { requireTurnToken } from "../auth/turn-token-middleware.ts";
import { db } from "../db/client.ts";
import { threads, type ThreadRow } from "../db/schema.ts";
import { automationTools } from "../automations/tools.ts";
import { conversationTools } from "../conversation/tools.ts";
import { beforeTool } from "../conversation/turn-record.ts";
import { specialistTools } from "../specialists/tools.ts";
import { moneyTools } from "../money/tools.ts";
import type { Reach } from "../money/recipe.ts";
import { walletReach } from "../money/wallets.ts";
import { offered } from "../apps/registry.ts";
import { watchedLookup } from "../app-troubles.ts";
import { readChainTool } from "../money/read-chain.ts";
import { auniCapabilityTools } from "./auni-tools.ts";
import { connectAppTool } from "./connect-tool.ts";
import { sendFeedbackTool } from "./feedback-tool.ts";
import { fetchUrlTool } from "./fetch-tool.ts";
import { sayInputErrorsPlainly } from "./input-errors.ts";
import { suggestRepliesTool } from "./replies.ts";
import { saveRoutineTool } from "./routine-tool.ts";
import { requestSecretTool } from "./secret-tool.ts";
import { loadSkillTool } from "./skills.ts";
import { sealCard } from "./card-seal.ts";
import { toolInput, type AuniTool, type ToolTurn } from "./tool.ts";

// Each sits far above what a real call needs (the largest are a dozen legs, or eight calls of
// calldata), so the agent, which whatever it reads can steer, can't make validating one request
// run core out of memory.
const MAX_TOOL_INPUT_ELEMENTS = 1_000;
const MAX_REQUEST_BYTES = 1024 * 1024;

interface ToolContext {
  readonly thread: ThreadRow;
}

/**
 * A server whose tools' cards leave sealed (card-seal.ts). `beforeEach` runs before each tool
 * that is called does. The MCP SDK checks each call against its tool's input (toolInput) before
 * the tool runs, and refuses one that fails in a sentence saying what to send (input-errors.ts).
 */
export function buildMcpServer(
  tools: readonly AuniTool[],
  beforeEach: () => Promise<void> = async () => {},
): McpServer {
  sayInputErrorsPlainly();
  const server = new McpServer(
    { name: "auni", version: "1.0.0" },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: toolInput(tool.inputSchema) },
      async (input) => {
        await beforeEach();
        return withMessage(
          sealCard(await tool.handler(input as z.infer<z.ZodObject<ZodRawShape>>)),
        );
      },
    );
  }
  return server;
}

/**
 * Claude Code shows the agent a tool's structuredContent in place of its text, and Codex does too
 * whenever there is one, so the text (what happened, what to do next) rides along inside it as
 * `message`.
 */
function withMessage(result: CallToolResult): CallToolResult {
  if (!result.structuredContent) return result;
  const message = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  return message
    ? { ...result, structuredContent: { message, ...result.structuredContent } }
    : result;
}

/** Permission enforcement lives in these core-side handlers: the agent holds this turn's token, so nothing it runs is trusted. */
export function toolsFor(context: ToolContext, reach: Reach = { solana: true }): AuniTool[] {
  const turn: ToolTurn = {
    threadId: context.thread.id,
    specialistId: context.thread.specialistId,
  };
  return [
    // What the owner's wallet can move on decides the money tools it is offered.
    ...moneyTools(turn, reach),
    // Each app's lookups; one unconfigured gives none, so the agent never sees tools that can't answer.
    ...offered().flatMap(({ about, lookups }) =>
      (lookups?.() ?? []).map((tool) => watchedLookup(about, tool)),
    ),
    ...specialistTools(turn),
    ...automationTools(turn),
    ...conversationTools(turn),
    suggestRepliesTool(turn),
    loadSkillTool(),
    saveRoutineTool(turn),
    connectAppTool(turn),
    requestSecretTool(turn),
    sendFeedbackTool(turn),
    ...auniCapabilityTools(),
    readChainTool({
      threadId: context.thread.id,
      turnStartedAt: context.thread.turnStartedAt?.toISOString() ?? "",
    }),
    fetchUrlTool(),
  ];
}

async function loadContext(threadId: string): Promise<ToolContext | undefined> {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  return thread && { thread };
}

async function handleMcp(req: Request, res: Response): Promise<void> {
  const context = await loadContext(req.turn!.threadId);
  if (!context) {
    res
      .status(403)
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "forbidden" }, id: null });
    return;
  }
  // Stateless: a fresh server and transport per request. The turn's record says it called a tool
  // before the tool runs, so a turn cut off just after is known to have acted.
  const server = buildMcpServer(toolsFor(context, await walletReach()), () =>
    beforeTool(context.thread.id),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("mcp request failed", error);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  }
}

export const mcpRouter = Router();

mcpRouter.post("/mcp", requireTurnToken, (req, res) => void handleMcp(req, res));
mcpRouter.all("/mcp", (_req, res) => {
  res.status(405).set("allow", "POST").end();
});
