import type { EdgeScene } from "@/components/brand/edge-pose";

import type { MoveRow } from "./move-rows";

/**
 * What Auni, over a money card's edge, makes of the card's rows: before the
 * tap it waits with the person, for their money first where it must come in; while the money moves it watches the row
 * happening now, unless one didn't go through; after, it celebrates, or
 * looks to the row that needs the person, or, with nothing left to try, is
 * sad.
 */
export function edgeScene({
  phase,
  retry,
  rows,
}: {
  /** Before the tap, waiting on money first ("fund") or ready to start. */
  readonly phase: "fund" | "before" | "running" | "after";
  /** The card offers to try what didn't go through again. */
  readonly retry: boolean;
  readonly rows: readonly MoveRow[];
}): EdgeScene {
  if (phase === "fund") return { kind: "funding" };
  if (phase === "before") return { kind: "ready" };
  const failed = rows.find((row) => row.status === "failed");
  if (phase === "running") {
    if (failed) return { kind: "attention", row: failed.key, settled: false };
    return { kind: "running", row: rows.find((row) => row.status === "now")?.key ?? null };
  }
  if (failed) {
    return retry ? { kind: "attention", row: failed.key, settled: true } : { kind: "failed" };
  }
  return rows.some((row) => row.status === "done") ? { kind: "landed" } : { kind: "failed" };
}
