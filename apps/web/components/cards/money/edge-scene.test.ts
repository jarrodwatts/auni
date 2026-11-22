import { describe, expect, it } from "vitest";

import type { Status } from "@/components/motion/status-mark";

import { edgeScene } from "./edge-scene";
import type { MoveRow } from "./move-rows";

/** Rows by key and status, which is all Auni reads of them. */
function rows(statuses: Record<string, Status>): MoveRow[] {
  return Object.entries(statuses).map(([key, status]) => ({
    key,
    logo: null,
    badge: null,
    label: key,
    tags: [],
    line: null,
    result: null,
    meta: null,
    status,
    failure: null,
    pick: null,
  }));
}

describe("edgeScene", () => {
  it("waits with the person before the tap", () => {
    expect(edgeScene({ phase: "before", retry: false, rows: rows({ a: "waiting" }) })).toEqual({
      kind: "ready",
    });
    expect(edgeScene({ phase: "fund", retry: false, rows: rows({ a: "waiting" }) })).toEqual({
      kind: "funding",
    });
  });

  it("watches the first row happening now while the money moves", () => {
    expect(
      edgeScene({
        phase: "running",
        retry: false,
        rows: rows({ bridge: "done", nvidia: "now", amd: "now", tsmc: "waiting" }),
      }),
    ).toEqual({ kind: "running", row: "nvidia" });
  });

  it("watches nothing in particular between rows", () => {
    expect(
      edgeScene({ phase: "running", retry: false, rows: rows({ a: "done", b: "waiting" }) }),
    ).toEqual({ kind: "running", row: null });
  });

  it("turns to a row that didn't go through, even while others still run", () => {
    expect(
      edgeScene({ phase: "running", retry: false, rows: rows({ a: "failed", b: "now" }) }),
    ).toEqual({ kind: "attention", row: "a", settled: false });
  });

  it("celebrates once everything went through", () => {
    expect(
      edgeScene({ phase: "after", retry: true, rows: rows({ a: "done", b: "done" }) }),
    ).toEqual({ kind: "landed" });
  });

  it("looks to the row the person can try again", () => {
    expect(
      edgeScene({
        phase: "after",
        retry: true,
        rows: rows({ a: "done", b: "failed", c: "failed" }),
      }),
    ).toEqual({ kind: "attention", row: "b", settled: true });
  });

  it("is sad when what didn't go through can't be tried again here", () => {
    expect(
      edgeScene({ phase: "after", retry: false, rows: rows({ a: "done", b: "failed" }) }),
    ).toEqual({ kind: "failed" });
  });

  it("is sad when it's over and nothing went through", () => {
    expect(edgeScene({ phase: "after", retry: false, rows: rows({ a: "waiting" }) })).toEqual({
      kind: "failed",
    });
  });
});
