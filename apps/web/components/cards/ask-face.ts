import { ASK_LINE, type AskCardWire } from "@auni/shared";

type Line = AskCardWire["lines"][number];

/** An ask as its card draws it: every word is one core recorded, only laid out. */
export interface AskFace {
  /** What the tap agrees to, as core's summary says it. */
  readonly title: string;
  /** The quiet line under the title: how a thread it changes will act. */
  readonly line: string | null;
  /** The one number the card is about, with its word under it: "$1,500", "budget". */
  readonly figure: { readonly value: string; readonly label: string } | null;
  /** Every other line the tap agrees to, in core's order. None is ever left out. */
  readonly details: readonly Line[];
  /** The main button, in core's words for what the tap does: "Allow auto up to $500". */
  readonly action: string;
}

/**
 * Lays an ask out as a card: its budget as the figure, how it acts as the line under the title,
 * and the rest as details. A line is found by the label core wrote it under (ASK_LINE), so an
 * ask with neither reads as its summary over all of its lines.
 */
export function askFace({
  summary,
  lines,
  action,
}: Pick<AskCardWire, "summary" | "lines" | "action">): AskFace {
  const budget = lines.find(({ label }) => label === ASK_LINE.budget);
  const acts = lines.find(({ label }) => label === ASK_LINE.acts);
  return {
    title: summary,
    line: acts?.value ?? null,
    figure: budget ? { value: budget.value, label: budget.label.toLowerCase() } : null,
    details: lines.filter((line) => line !== budget && line !== acts),
    action,
  };
}

/** Each kind of ask's summary as it reads once done, by how core words it, in the past tense. */
const DONE_TITLES: readonly (readonly [RegExp, string])[] = [
  [/^Save a routine: /u, "Saved routine: "],
  [/^Replace your routine: /u, "Replaced your routine: "],
  [/^Turn (.+) on$/u, "Turned $1 on"],
  [/^Let this thread /u, "This thread can now "],
  [/^Let (.+?) trade /u, "$1 can now trade "],
];

/**
 * What an allowed ask is called once it applied, as a money card's receipt is: in the past tense
 * ("Saved routine: Friday check"), or its summary where it has no other way to say it. Null when
 * it reads no differently, so the card says it is done in words of its own.
 */
export function doneTitle(summary: string): string | null {
  const known = DONE_TITLES.find(([asked]) => asked.test(summary));
  return known ? summary.replace(known[0], known[1]) : null;
}
