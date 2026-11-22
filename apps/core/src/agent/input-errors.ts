import { withArticle } from "@auni/shared";
import { z } from "zod";

/**
 * What a tool's input got wrong, said as a sentence the agent can act on in one try. The MCP SDK
 * checks every tool call against its schema before the tool runs and answers a failure with zod's
 * own message, such as "Invalid input: expected boolean, received string", which leaves the agent
 * guessing what to change. A value whose meaning is plain is read as meant before that check
 * (textAsMeant, in @auni/shared), so what reaches here is a value that can't be: this names the
 * field, what it must be, what was sent, and how to send it. Zod asks it first for every message it
 * writes; for any problem it has no words for it says nothing, and zod's own message stands.
 */
function plainInputError(issue: z.core.$ZodRawIssue): string | undefined {
  const field = issue.path?.length ? fieldName(issue.path) : "The input";
  const sent = issue.input;
  if (issue.code === "invalid_type") {
    if (sent === undefined) return `${field} is missing: it must be given, as ${a(issue.expected)}`;
    return `${field} must be ${a(issue.expected)}, and it was sent as ${sentAs(sent)}${howToSend(issue.expected, sent)}`;
  }
  if (issue.code === "invalid_value" && issue.values.length > 0) {
    const wanted = issue.values.map(written);
    const one = wanted.length === 1 ? wanted[0] : `one of ${wanted.join(", ")}`;
    const bare = issue.values.every((value) => typeof value !== "string");
    return `${field} must be ${one}${bare ? ", without quotes" : ""}, and it was sent as ${sentAs(sent)}`;
  }
  if (issue.code === "invalid_union") return closestForm(issue.errors);
  return undefined;
}

/**
 * A value that fits none of a field's forms (a watch's condition is a price level or a move) is
 * told what is wrong with the form it came closest to, when one came closest; zod alone says
 * only "Invalid input". Each form's problems are already in these words.
 */
function closestForm(forms: readonly (readonly z.core.$ZodIssue[])[]): string | undefined {
  const [closest, next] = forms.toSorted((a, b) => a.length - b.length);
  if (!closest?.length || (next && next.length === closest.length)) return undefined;
  return closest.map((problem) => problem.message).join("; ");
}

/** A hint for text sent where something else goes: what to send in its place. */
function howToSend(expected: string, sent: unknown): string {
  if (typeof sent !== "string") return "";
  if (expected === "boolean") return ": send true or false, without quotes";
  if (expected === "number" && sent.trim() !== "" && Number.isFinite(Number(sent)))
    return `: send it as ${Number(sent)}, without quotes`;
  if (expected === "array" || expected === "object" || expected === "record")
    return `: send the ${expected === "array" ? "list" : "object"} itself, not text`;
  return "";
}

/** "legs[0].amountUsd", as the agent wrote it. */
function fieldName(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : `${index > 0 ? "." : ""}${String(key)}`,
    )
    .join("");
}

/** A value the schema takes, as the agent would write it. */
function written(value: unknown): string {
  return typeof value === "bigint" ? String(value) : JSON.stringify(value);
}

/** What was sent, kind and value: `text ("yes")`, `the number 5`, `an array`. */
function sentAs(value: unknown): string {
  if (typeof value === "string") {
    const shown = value.length > 80 ? `${value.slice(0, 80)}...` : value;
    return `text (${JSON.stringify(shown)})`;
  }
  if (typeof value === "number" || typeof value === "boolean")
    return `the ${typeof value} ${String(value)}`;
  return a(kindOf(value));
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function a(kind: string): string {
  if (kind === "string") return "text";
  if (kind === "null") return "null";
  return withArticle(kind);
}

/** Puts plainInputError first for every message zod writes in this process. */
export function sayInputErrorsPlainly(): void {
  z.config({ customError: plainInputError });
}
