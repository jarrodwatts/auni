import { z } from "zod";

import { formatUsd } from "./money";

/**
 * What a finished step found, in a few words for the right of its row: "$412
 * in cash", "SOL $182.40", "6 stories". A tool says its own (`found` beside its
 * words, agent/tool.ts); core's two that say none are read from their output,
 * which no type promises: anything it can't read says nothing rather than guess.
 */
export function toolResult(toolName: string, output: unknown): string | null {
  const said = foundSchema.safeParse(output);
  if (said.success) return said.data.found;
  const text = outputText(output);
  if (text === null) return null;
  switch (toolName) {
    case "get_portfolio":
      return portfolioResult(text);
    case "find_instruments": {
      const found = readJson(text, instrumentsSchema);
      return found ? counted(found.candidates.length, "pick", "picks") : null;
    }
    default:
      return null;
  }
}

/**
 * A tool's words, however they reached the browser: a plain string, the MCP
 * `{content}` wrapper around one, or a list of content blocks.
 */
function outputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const texts = output.flatMap((block) => {
      const parsed = textBlockSchema.safeParse(block);
      return parsed.success ? [parsed.data.text] : [];
    });
    return texts.length > 0 ? texts.join("\n") : null;
  }
  if (output && typeof output === "object" && "content" in output) {
    return outputText(output.content);
  }
  return null;
}

/** JSON in the text: inside `<tag>…</tag>` when a tool fences its data, else the text itself. */
function readJson<T>(text: string, schema: z.ZodType<T>, tag?: string): T | null {
  const fenced = tag ? new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`, "u").exec(text)?.[1] : text;
  if (fenced === undefined) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(fenced));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function portfolioResult(text: string): string | null {
  const portfolio = readJson(text, portfolioSchema, "portfolio");
  if (!portfolio) return null;
  const cash = portfolio.cash?.usdValue;
  if (cash === undefined || Number(cash) <= 0) return `${formatUsd(portfolio.totalUsd)} in total`;
  // The portfolio's Cash, as the screens say it; and, where the agent was told less is free for
  // what's waiting on cards, how much those count on, so neither figure reads as the other.
  const promised = portfolio.cashPromisedToWaitingCardsUsd;
  return promised !== undefined && Number(promised) > 0
    ? `${formatUsd(cash)} in cash, ${formatUsd(promised)} for waiting cards`
    : `${formatUsd(cash)} in cash`;
}

function counted(count: number, one: string, many: string): string {
  if (count === 0) return `No ${many}`;
  return `${count} ${count === 1 ? one : many}`;
}

/** What a tool says it found, beside its words (see `result` in core's agent/tool.ts). */
const foundSchema = z.object({ found: z.string().trim().min(1).max(60) });

const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

/** Core's dollar amounts are decimal strings ("412.5"). */
const usdSchema = z.string().regex(/^-?\d+(\.\d+)?$/u);

const portfolioSchema = z.object({
  totalUsd: usdSchema,
  cash: z.object({ usdValue: usdSchema }).optional(),
  cashPromisedToWaitingCardsUsd: usdSchema.optional(),
});

const instrumentsSchema = z.object({ candidates: z.array(z.unknown()) });
