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
          body="Auni only opens in browsers paired from your terminal."
        >
          <PairSteps machine={machine} then="This page opens automatically once paired." />
        </GateScreen>
      );
    case "link-used":
      return (
        <GateScreen
          pose="sad"
          waiting
          title="This link no longer works"
          body="Pairing links work once and expire after 15 minutes."
        >
          <PairSteps machine={machine} then="This page opens automatically once paired." />
        </GateScreen>
      );
    case "tailscale-only":
      return (
        <GateScreen
          pose="listening"
          title="Open Auni through Tailscale"
          body={`${machine ? `Auni on ${machine}` : "This Auni"} only opens with your Tailscale login, from your phone or another computer.`}
        />
      );
    case "database":
      return (
        <GateScreen
          pose="sad"
          waiting
          title="Auni can't reach its database"
          body="Your wallet is untouched, and no moves can run while it's down."
        >
          <DoctorSteps
            machine={machine}
            then="Auni opens automatically once the database is back."
          />
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
      body="Auni moved there so it stays online while this computer sleeps. Nothing runs here anymore, and this local copy stays until you run auni uninstall."
    >
      {to ? (
        <Button size="lg" className="w-full" onClick={() => window.location.assign(to)}>
          Open Auni on {machine}
        </Button>
      ) : null}
    </GateScreen>
  );
}
