import type { Status } from "@/components/motion/status-mark";

/** Beat after the last step finishes before a live work panel smoothly collapses shut. */
export const AUTO_COLLAPSE_DELAY_MS = 420;

/** Maximum distinct step icons layered in a work panel's header stack. */
const MAX_HEADER_ICONS = 5;

interface WorkStepMeta {
  readonly iconKey: string;
  readonly isTool: boolean;
  readonly status: Status | null;
}

/**
 * Picks up to `max` distinct icons for the header stack in order of first use.
 * Tool icons take the stack once any tool has run, keeping a quiet thought from
 * crowding out the services that actually did the work.
 */
export function uniqueStepIcons<T extends Pick<WorkStepMeta, "iconKey" | "isTool">>(
  steps: readonly T[],
  max = MAX_HEADER_ICONS,
): readonly T[] {
  const hasTools = steps.some((step) => step.isTool);
  const source = hasTools ? steps.filter((step) => step.isTool) : steps;
  const seen = new Set<string>();
  const picked: T[] = [];
  for (const step of source) {
    if (seen.has(step.iconKey)) continue;
    seen.add(step.iconKey);
    picked.push(step);
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * The work panel's header words: live step count while a tool is running, honest
 * thinking status between steps once current tools finish, live detail if collapsed
 * mid-work, and a compact summary once settled.
 */
export function workPanelHeaderLabel(input: {
  readonly active: boolean;
  readonly anyRunning?: boolean;
  readonly open: boolean;
  readonly liveLabel?: string | null | undefined;
  readonly toolCount: number;
  readonly thoughtCount: number;
}): string {
  const { active, anyRunning = true, liveLabel, open, thoughtCount, toolCount } = input;
  if (active) {
    if (!open && liveLabel) return liveLabel;
    if (toolCount > 0) {
      if (!anyRunning) return liveLabel ?? "Thinking";
      return toolCount === 1 ? "Working on 1 step" : `Working on ${toolCount} steps`;
    }
    if (thoughtCount > 0) return open ? "Thinking" : (liveLabel ?? "Thinking");
    return liveLabel ?? "Thinking";
  }
  if (toolCount > 0) return toolCount === 1 ? "1 step" : `${toolCount} steps`;
  if (thoughtCount > 0) return "Thought";
  return "Worked";
}

/**
 * A live work panel folds itself shut once all of its tool steps completed
 * cleanly and either following words arrived or the turn ended. A running,
 * failed, or interrupted tool step keeps the panel open so the owner sees
 * where work stopped.
 */
export function shouldAutoCollapse(input: {
  readonly hasSteps: boolean;
  readonly anyIncomplete: boolean;
  readonly canCollapse: boolean;
}): boolean {
  return input.hasSteps && !input.anyIncomplete && input.canCollapse;
}

/**
 * Initial collapsed state on mount: panels loaded from history start collapsed
 * only when every tool step finished cleanly and the turn settled; failed,
 * stopped, or running steps open expanded immediately.
 */
export function initialAutoCollapsed(input: {
  readonly liveOnMount: boolean;
  readonly hasSteps: boolean;
  readonly anyIncomplete: boolean;
  readonly canCollapse: boolean;
}): boolean {
  return !input.liveOnMount && shouldAutoCollapse(input);
}
