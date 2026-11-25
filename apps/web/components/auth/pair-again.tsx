"use client";

import { useEffect, useRef } from "react";

import { PairSteps } from "@/components/auth/gate-screen";
import { CoreApiError } from "@/lib/core";
import { noteTerminalTrip } from "@/lib/terminal-trip";
import { cn } from "@/lib/utils";
import { useRemoteMachine } from "@/lib/where-auni-runs";

/**
 * Core's answer that a step takes proof the owner is there and this browser has none to give: it
 * paired over 15 minutes ago (core's `auth/proof.ts`). The way on is `PairAgain`.
 */
export function mustPairAgain(error: unknown): boolean {
  return error instanceof CoreApiError && error.code === "pair_again";
}

/**
 * The way on when a step takes proof the owner is there and this browser has none to give
 * (`mustPairAgain`). Pairing again takes the terminal where Auni runs, which is the proof. Nothing
 * was done, and what they were doing waits; `then` says what to do once back.
 */
export function PairAgain({
  then,
  className,
}: {
  readonly then: string;
  /** Where it sits: its margins in the surface around it. */
  readonly className?: string;
}) {
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // So the tab the pairing link opens comes back to this page, and the dialog its address names
    // (lib/terminal-trip.ts).
    noteTerminalTrip(window.location.pathname + window.location.search);
    // It appears where the owner tapped; in a pane that scrolls, all of it comes into view.
    note.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const machine = useRemoteMachine();
  return (
    <div
      ref={note}
      role="alert"
      className={cn("rounded-card border border-border px-4 py-4 text-left", className)}
    >
      <p className="text-ui font-medium text-ink">Confirm it&apos;s you</p>
      <p className="mt-1 text-meta text-pretty text-muted-foreground">
        This browser paired over 15 minutes ago. Pair it again to continue.
      </p>
      <PairSteps machine={machine} then={then} className="mt-4" />
    </div>
  );
}
