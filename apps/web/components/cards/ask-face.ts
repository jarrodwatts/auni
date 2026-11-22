import { ASK_LINE, type AskCardWire } from "@auni/shared";

type Line = AskCardWire["lines"][number];

/** An ask as its card draws it: every word is one core recorded, only laid out. */
export interface AskFace {
  /** What the tap agrees to, as core's summary says it. */
  readonly title: string;
  /** The quiet line under the title: how a specialist it starts will act. */
  readonly line: string | null;
  /** The one number the card is about, with its word under it: "$1,500", "pot". */
  readonly figure: { readonly value: string; readonly label: string } | null;
  /** Every other line the tap agrees to, in core's order. None is ever left out. */
  readonly details: readonly Line[];
  /** The main button, in core's words for what the tap does: "Start with $500". */
  readonly action: string;
}

/**
 * Lays an ask out as a card: its pot as the figure, how it acts as the line under the title,
 * and the rest as details. A line is found by the label core wrote it under (ASK_LINE), so an
 * ask with neither reads as its summary over all of its lines.
 */
export function askFace({
  summary,
  lines,
  action,
}: Pick<AskCardWire, "summary" | "lines" | "action">): AskFace {
  const pot = lines.find(({ label }) => label === ASK_LINE.pot);
  const acts = lines.find(({ label }) => label === ASK_LINE.acts);
  return {
    title: summary,
    line: acts?.value ?? null,
    figure: pot ? { value: pot.value, label: pot.label.toLowerCase() } : null,
    details: lines.filter((line) => line !== pot && line !== acts),
    action,
  };
}
