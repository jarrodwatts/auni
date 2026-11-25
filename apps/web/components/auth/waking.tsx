"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { subscribeSecondTick } from "@/lib/tick-text";
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
  // From the first wait: the page asking who this is becomes the start's own wait in place.
  const [since] = useState(() => Date.now());
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
          ? "This is taking longer than usual."
          : "This page opens automatically when Auni is ready. A first start takes about a minute."
      }
    >
      {/* What the page waits on, and for how long, so a slow start never looks frozen. */}
      <p className="flex items-center justify-center gap-2 text-meta text-muted-foreground">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        <span>Waiting for Auni to answer</span>
        <WaitedFor since={since} />
      </p>
      {slow ? (
        <DoctorSteps
          machine={machine}
          then="Auni opens automatically once it's running."
          className="mt-6"
        />
      ) : null}
    </GateScreen>
  );
}

/** How long the page has waited, "12s" or "1m 5s", counting on the tab's shared second. */
function WaitedFor({ since }: { readonly since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => subscribeSecondTick(() => setNow(Date.now())), []);
  const seconds = Math.floor((now - since) / 1_000);
  if (seconds < 1) return null;
  const minutes = Math.floor(seconds / 60);
  return (
    <span aria-hidden className="text-ink-soft tabular-nums">
      {minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`}
    </span>
  );
}
