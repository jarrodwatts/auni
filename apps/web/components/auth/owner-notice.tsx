"use client";

import { Button } from "@/components/ui/button";
import { useRemoteMachine } from "@/lib/where-auni-runs";

import { DoctorSteps, GateScreen, PairSteps } from "./gate-screen";

/** Why core won't open the app to this browser, or can't yet; each re-read by itself. */
type Reason = "unpaired" | "link-used" | "tailscale-only" | "database";

/** What a browser sees when it isn't the owner's, or Auni can't answer, and the way on. */
export function OwnerNotice({ reason }: { readonly reason: Reason }) {
  const machine = useRemoteMachine();
  switch (reason) {
    case "unpaired":
      return (
        <GateScreen
          pose="listening"
          waiting
          title="Pair this browser"
          body="Auni opens only in browsers you pair from its terminal."
        >
          <PairSteps machine={machine} then="This page opens Auni by itself once you have." />
        </GateScreen>
      );
    case "link-used":
      return (
        <GateScreen
          pose="sad"
          waiting
          title="This link no longer works"
          body="A pairing link works once, within 15 minutes."
        >
          <PairSteps machine={machine} then="This page opens Auni by itself once you have." />
        </GateScreen>
      );
    case "tailscale-only":
      return (
        <GateScreen
          pose="listening"
          title="Open Auni through Tailscale"
          body={`${machine ? `Auni on ${machine}` : "This Auni"} opens only for its owner's Tailscale login, from your phone or another computer.`}
        />
      );
    case "database":
      return (
        <GateScreen
          pose="sad"
          waiting
          title="Auni can't reach its database"
          body="Nothing can move while it's down, and your wallet isn't touched."
        >
          <DoctorSteps machine={machine} then="Auni opens here by itself once it's back." />
        </GateScreen>
      );
  }
}

/**
 * What this computer's Auni shows once it was handed over: where it runs now, and the way there.
 * Nothing here was removed, and nothing here runs.
 */
export function HandedOverNotice({
  to,
  machine,
}: {
  readonly to: string;
  readonly machine: string;
}) {
  return (
    <GateScreen
      pose="color"
      title={`Auni runs on ${machine} now`}
      body="It moved there so it keeps going while this computer sleeps. Nothing runs here, and nothing was removed: this copy stays until you run auni uninstall."
    >
      {to ? (
        <Button size="lg" className="w-full" onClick={() => window.location.assign(to)}>
          Open Auni on {machine}
        </Button>
      ) : null}
    </GateScreen>
  );
}
