/**
 * One look for every settings pane: rows of the same height, a label on the
 * left with an optional hint under it, and the control flush to the right edge.
 */
export const GROUP =
  "divide-y divide-foreground/[0.06] overflow-hidden rounded-[14px] border border-foreground/[0.08] bg-card";
export const ROW = "flex min-h-[56px] items-center gap-4 px-4 py-2.5";
export const ROW_TEXT = "min-w-0 flex-1";
export const ROW_LABEL = "block text-[14px] leading-5 text-ink";
export const ROW_HINT = "mt-0.5 block truncate text-[12.5px] leading-4 text-muted-foreground";
