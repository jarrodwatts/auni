import { textAsMeant } from "@auni/shared";
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

/** A pick the agent weighed or chose: a company or coin, by its name and its logo. */
export interface PickWeighed {
  readonly name: string;
  readonly logo: string | null;
}

/** A candidate a market search (find_instruments) found. */
type Candidate = z.infer<typeof candidatesSchema>["candidates"][number];

/** What a market search found, or nothing for output it can't read. */
export function candidatesFound(output: unknown): readonly Candidate[] {
  const text = outputText(output);
  return (text === null ? null : readJson(text, candidatesSchema))?.candidates ?? [];
}

/**
 * The picks a market search found for what the agent named in it, by their own name or ticker
 * (never a name that only shares a word: Williams is not Williams-Sonoma): the companies it is
 * weighing, not every candidate the search turned up.
 */
export function picksNamed(input: unknown, output: unknown): readonly PickWeighed[] {
  const asked = findInputSchema.safeParse(input);
  if (!asked.success) return [];
  const found = candidatesFound(output);
  const picks = new Map<string, PickWeighed>();
  for (const term of [...(asked.data.related ?? []), asked.data.query]) {
    const pick = found.find((candidate) => names(term, candidate));
    if (pick && !picks.has(pick.name)) picks.set(pick.name, weighed(pick));
  }
  return [...picks.values()];
}

/**
 * The picks a proposal (propose_actions) puts on its card, each wearing the logo of
 * the candidate it trades (by what its leg names it with), or none; nothing for input it can't read.
 */
export function picksProposed(input: unknown, found: readonly Candidate[]): readonly PickWeighed[] {
  const proposal = proposalSchema.safeParse(input);
  if (!proposal.success) return [];
  return proposal.data.legs.flatMap((leg) => {
    const said = Object.values(leg.input ?? {}).flatMap((value) =>
      typeof value === "string" ? [value] : [],
    );
    const traded = found.find(
      (candidate) =>
        said.some((value) => names(value, candidate) || sameIdentifier(value, candidate)) ||
        (leg.name ? names(leg.name, candidate) : false),
    );
    const label = leg.name ?? traded?.name;
    return label ? [{ name: label, logo: traded?.logoUrl ?? null }] : [];
  });
}

const weighed = (candidate: Candidate): PickWeighed => ({
  name: candidate.name,
  logo: candidate.logoUrl ?? null,
});

const sameIdentifier = (value: string, { identifier }: Candidate) =>
  identifier !== undefined && value.toLowerCase() === identifier.toLowerCase();

/**
 * Whether `term` names `candidate`: its ticker (an xStock's with or without its x), or its name,
 * whatever case, punctuation or company ending ("GE Vernova" is "GE Vernova Inc.").
 */
function names(term: string, candidate: Pick<Candidate, "name" | "ticker">): boolean {
  const ticker = candidate.ticker.toUpperCase();
  const said = term.trim().toUpperCase();
  if (said === ticker || `${said}X` === ticker || said === `${ticker}X`) return true;
  const name = plainName(candidate.name);
  return name !== "" && plainName(term) === name;
}

/** Words that only say what kind of company it is. */
const COMPANY_ENDINGS = new Set([
  "inc",
  "corp",
  "corporation",
  "co",
  "company",
  "companies",
  "ltd",
  "plc",
  "sa",
  "nv",
  "ag",
  "holdings",
  "group",
]);

/** A name as words, lower case, without the company ending: "williams" for "The Williams Companies, Inc.". */
function plainName(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words[0] === "the") words.shift();
  while (words.length > 1 && COMPANY_ENDINGS.has(words.at(-1)!)) words.pop();
  return words.join(" ");
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

// A tool's input as the agent sent it, read as core reads it: a list sent as JSON text is a list.
const findInputSchema = z.object({
  query: z.string(),
  related: textAsMeant(z.array(z.string())).optional(),
});

const candidatesSchema = z.object({
  candidates: z.array(
    z.object({
      name: z.string(),
      ticker: z.string(),
      identifier: z.string().optional(),
      logoUrl: z.string().nullish(),
    }),
  ),
});

const proposalSchema = z.object({
  legs: textAsMeant(
    z.array(
      z.object({ name: z.string().optional(), input: z.record(z.string(), z.unknown()).optional() }),
    ),
  ),
});
