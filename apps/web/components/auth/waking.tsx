"use client";

import { useEffect, useState } from "react";

import { useRemoteMachine } from "@/lib/where-auni-runs";

import { DoctorSteps, GateScreen } from "./gate-screen";

/** How long a start may take before the page says where to look. */
const SLOW_MS = 75_000;

/**
 * Auni isn't answering yet: either the page is asking who this browser is (`opening`, usually a
 * blink, so it shows only once the wait is real), or no Auni answers yet (`starting`), read again
 * every few seconds until it does, when the page carries on by itself. A start that takes longer
 * than a first one should says where to see why.
 */
export function Waking({ step = "opening" }: { readonly step?: "opening" | "starting" }) {
  const machine = useRemoteMachine();
  const on = machine ? ` on ${machine}` : "";
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (step !== "starting") return undefined;
    const late = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(late);
  }, [step]);

  if (step === "opening")
    return <GateScreen pose="listening" waiting late title={`Opening Auni${on}`} />;
  return (
    <GateScreen
      pose="thinking"
      waiting
      title={`Starting Auni${on}`}
      body={
        slow
          ? "This is taking longer than a start should."
          : "This page opens by itself when it's ready. A first start takes about a minute."
      }
    >
      {slow ? (
        <DoctorSteps machine={machine} then="Auni opens here by itself once it's up." />
      ) : null}
    </GateScreen>
  );
}
