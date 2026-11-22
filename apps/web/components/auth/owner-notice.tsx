"use client";

import type { MascotState } from "@/components/brand/mascot";
import { OnboardingBackdrop } from "@/components/auth/onboarding-backdrop";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { Card, NoticeCard } from "@/components/auth/notice-card";

type Reason = "unpaired" | "link-used" | "starting" | "database";

const SAYS: Record<
  Reason,
  {
    readonly mascot: MascotState;
    readonly title: string;
    readonly body: string;
    readonly command?: string;
  }
> = {
  unpaired: {
    mascot: "listening",
    title: "This browser isn't signed in",
    body: "Run this where Auni runs, and open the link it prints here.",
    command: "auni pair",
  },
  "link-used": {
    mascot: "sad",
    title: "This link was already used",
    body: "A link works once, for 15 minutes. Run this where Auni runs for a new one.",
    command: "auni pair",
  },
  starting: {
    mascot: "thinking",
    title: "Auni is still starting",
    body: "This page carries on by itself as soon as it's up. The first start takes about a minute.",
  },
  database: {
    mascot: "sad",
    title: "Can't reach the database",
    body: "Auni is running, but its database isn't answering. Run this where Auni runs to see why.",
    command: "auni doctor",
  },
};

/** What a browser sees when it isn't the owner's, or Auni can't answer yet, and what to do. */
export function OwnerNotice({
  reason,
  onRetry,
}: {
  readonly reason: Reason;
  readonly onRetry: () => void;
}) {
  const says = SAYS[reason];
  return (
    <OnboardingBackdrop>
      <div className="w-full max-w-[480px] self-center px-4">
        <NoticeCard
          pose={says.mascot}
          waiting={reason === "starting"}
          title={says.title}
          body={says.body}
          {...(says.command ? { command: says.command } : {})}
          {...(reason === "database" ? { onRetry } : {})}
        />
      </div>
    </OnboardingBackdrop>
  );
}

/**
 * What this laptop's Auni shows once it was handed over: where it runs now, and the way there.
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
    <OnboardingBackdrop>
      <div className="w-full max-w-[480px] self-center px-4">
        <Card
          pose="color"
          title={`Auni runs on ${machine} now`}
          body="So it keeps going when this computer sleeps. Open it there from any of your devices on Tailscale. Nothing was removed here, and nothing here runs: this copy stays until you remove it with auni uninstall."
        >
          {to ? (
            <MoneyButton
              tone="primary"
              className="w-full"
              onClick={() => window.location.assign(to)}
            >
              Open Auni on {machine}
            </MoneyButton>
          ) : null}
        </Card>
      </div>
    </OnboardingBackdrop>
  );
}
