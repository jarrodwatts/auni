import { describe, expect, it } from "vitest";

import { toLiveProposal } from "./proposals";

/** One leg of a card as core serves it, running at `phase`. */
const leg = (id: string, phase: string | null) => ({
  id,
  threadId: null,
  proposalId: "7d0c0000-0000-4000-8000-0000000000aa",
  status: phase === null ? "done" : "running",
  phase,
  tool: "evm_swap",
  venue: null,
  summary: "Buy about $10 of Nvidia",
  amountUsd: "10.00",
  lines: [],
  details: {},
  run: {},
  input: {},
  txs: [],
  error: null,
  failureKind: null,
  attempts: 1,
  createdAt: "2026-11-13T09:00:00.000Z",
  startedAt: null,
  updatedAt: "2026-11-13T09:00:00.000Z",
});

describe("a card's legs from core", () => {
  // A leg allowed but waiting its turn shows as waiting; one sending or on its way shows as now.
  it("says a leg has started only once it is past the queue", () => {
    const ids = ["queued", "sending", "landing", "unsure"].map(
      (_, index) => `7d0c0000-0000-4000-8000-00000000000${index}`,
    );
    const { legs } = toLiveProposal({
      actions: ["queued", "sending", "landing", "unsure"].map((phase, index) =>
        leg(ids[index]!, phase),
      ),
      funding: null,
      opens: false,
    });
    expect(legs.map(({ started }) => started)).toEqual([false, true, true, true]);
  });

  it("says a leg is held only while it waits on the owner", () => {
    const { legs } = toLiveProposal({
      actions: ["sending", "unsure", "needs_owner", null].map((phase, index) =>
        leg(`7d0c0000-0000-4000-8000-00000000001${index}`, phase),
      ),
      funding: null,
      opens: false,
    });
    expect(legs.map(({ held }) => held)).toEqual([false, false, true, false]);
  });
});
