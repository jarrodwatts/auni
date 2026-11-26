import { joinPicks } from "@/lib/conversation";
import type { Status } from "@/components/motion/status-mark";

/**
 * What a turn's work is made of, between its words: Auni's thoughts, each shown whole on a quiet
 * rail, and runs of steps (tools it ran), each run shown as one line that says what it did.
 */
export type TurnBlock<Thought, Step> =
  | { readonly kind: "thought"; readonly thought: Thought }
  | { readonly kind: "steps"; readonly steps: readonly Step[] };

/** Splits the work before some words into thoughts and runs of steps, in the order they came. */
export function turnBlocks<Thought, Step>(
  items: readonly ({ readonly thought: Thought } | { readonly step: Step })[],
): readonly TurnBlock<Thought, Step>[] {
  const blocks: TurnBlock<Thought, Step>[] = [];
  for (const item of items) {
    if ("thought" in item) {
      blocks.push({ kind: "thought", thought: item.thought });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === "steps")
      blocks[blocks.length - 1] = { kind: "steps", steps: [...last.steps, item.step] };
    else blocks.push({ kind: "steps", steps: [item.step] });
  }
  return blocks;
}

/**
 * What a run of finished steps did, as one line: "Checked your money and put your moves
 * together". Each step's own words, in order, once each; never a count or a time.
 */
export function stepsSummary(titles: readonly string[]): string {
  const [first, ...rest] = [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
  // Every step's words start with its verb, so only the first keeps its capital.
  return first === undefined ? "" : joinPicks([first, ...rest.map(lowerFirst)]);
}

function lowerFirst(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}

/**
 * Whether a run of steps folds to its one line. It stays open while a step is under way, and
 * when one failed or never finished, so the owner sees where the work stopped; it folds once
 * the run is over and something came after it, or the turn ended.
 */
export function stepsFold(input: {
  readonly statuses: readonly (Status | null)[];
  readonly over: boolean;
}): boolean {
  return input.over && input.statuses.every((status) => status === "done");
}
