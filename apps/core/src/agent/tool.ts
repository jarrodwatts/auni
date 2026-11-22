import { textAsMeant, type AuniToolName } from "@auni/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

import { errorWords } from "../safe-words.ts";

/** The turn a tool call acts for; loaded server-side from the turn token, never from the agent. */
export interface ToolTurn {
  readonly threadId: string;
}

export interface AuniTool<Shape extends ZodRawShape = ZodRawShape> {
  readonly name: AuniToolName;
  readonly description: string;
  readonly inputSchema: Shape;
  handler(input: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult>;
}

/** Erases a tool's input type so tools with different shapes share one list. */
export function defineTool<Shape extends ZodRawShape>(tool: AuniTool<Shape>): AuniTool {
  return tool as unknown as AuniTool;
}

/**
 * A tool's input as core reads it, wherever the agent's call is checked: by the MCP server, and
 * as a leg of a plan. A value sent as text is read as what it plainly means (textAsMeant) before
 * the schema's own checks run; each field reads its own, so the object stays one the MCP SDK
 * lists as it is.
 */
export function toolInput<Shape extends ZodRawShape>(shape: Shape): z.ZodObject<Shape> {
  return z.object(
    Object.fromEntries(
      Object.entries(shape).map(([field, schema]) => [field, textAsMeant(schema)]),
    ) as unknown as Shape,
  );
}

/**
 * A tool's answer: its words for the agent, and what the web reads of it. `found` is what the
 * step's row says it found, in a few words at its right ("6 markets", "SOL $182.40"); `card` a
 * card core seals (card-seal.ts).
 */
export function result(
  text: string,
  structuredContent?: { readonly found?: string } & Record<string, unknown>,
): CallToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

/** A count as a step's row says it: "No markets", "1 market", "6 markets". */
export function counted(count: number, one: string, many: string): string {
  if (count === 0) return `No ${many}`;
  return `${count} ${count === 1 ? one : many}`;
}

/** The error each failed answer was made from, kept in core and never sent (see causeOf). */
const causes = new WeakMap<CallToolResult, unknown>();

/** A tool that failed, as the agent is told it: never a link or a secret it quoted (safe-words.ts). */
export function failure(error: unknown): CallToolResult {
  const answer: CallToolResult = {
    content: [{ type: "text", text: errorWords(error) }],
    isError: true,
  };
  causes.set(answer, error);
  return answer;
}

/**
 * The error a failed answer was made from, for core to act on what kind it was (an app's key out
 * of credits, app-troubles.ts); undefined for an answer that didn't fail.
 */
export function causeOf(answer: CallToolResult): unknown {
  return causes.get(answer);
}
