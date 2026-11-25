"use client";

import { useCallback, useRef, useState } from "react";

import { StartingPoints } from "@/components/app/starting-points";
import { WelcomeComposer } from "@/components/app/welcome-composer";
import { AppMark } from "@/components/apps/app-mark";
import {
  InteractiveMascot,
  type InteractiveMascotHandle,
  type MascotReadingTarget,
} from "@/components/brand/interactive-mascot";
import { useMe } from "@/components/personalization/use-me";
import { useBrains } from "@/lib/data/brains";
import { useSetup } from "@/lib/data/setup";

import { BringWallet } from "./bring-wallet";
import { nothingThinks, readyBrain } from "./first-run";
import { PickYourAi } from "./pick-your-ai";
import { whereAuniRuns } from "./where";

/**
 * First run: the owner's first take, asked straight away. Only an AI that can't think yet stops
 * it, and then only until one can (PickYourAi). Under the take, one quiet line says what's ready;
 * the wallet is made as the take is sent (useFirstTake), unless the owner brings their own
 * first. Remote access, signals and the rest are Settings', for later.
 */
export function FirstTake() {
  const brains = useBrains();
  const { reach } = useMe();
  const machine = whereAuniRuns(reach);
  // Nothing until the brains are read, so the question never shows and then gives way to
  // Pick your AI. Brains that can't be read leave the question: the take's chat says why.
  const page = brains.isPending ? null : brains.data &&
    (nothingThinks(brains.data) || brains.data.blocked) ? (
    <PickYourAi brains={brains.data} machine={machine} />
  ) : (
    <Question />
  );

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-10 pb-4 sm:justify-center sm:px-8 sm:pb-16">
        {page}
      </div>
    </section>
  );
}

function Question() {
  const mascot = useRef<InteractiveMascotHandle>(null);
  const trackCaret = useCallback((target: MascotReadingTarget) => {
    mascot.current?.trackCaret(target);
  }, []);
  return (
    <>
      {/* On a phone the box sits at the bottom where a thumb is, with the ready line under it,
          and the ideas just above; wider, all of it stands in the middle. */}
      <div className="flex flex-1 flex-col items-center justify-center pb-6 sm:flex-none sm:pb-0">
        <InteractiveMascot ref={mascot} size={104} className="size-22 sm:size-[104px]" />
        <h1 className="mt-4 text-center text-title text-ink">What&apos;s a take you have?</h1>
      </div>
      <div className="order-last mt-2 w-full max-w-[680px] sm:order-none sm:mt-8">
        <WelcomeComposer onCaretActivity={trackCaret} />
      </div>
      <div className="w-full max-w-[680px] sm:mt-3">
        <StartingPoints />
      </div>
      <Ready />
    </>
  );
}

/**
 * One quiet line: which AI will answer, and where the wallet stands. Drawn once the brains are
 * read, so it never says one thing and then another.
 */
function Ready() {
  const brains = useBrains();
  const wallet = useSetup().data?.wallet;
  const [bringing, setBringing] = useState(false);
  const ready = readyBrain(brains.data?.rows ?? []);
  if (!ready || !wallet)
    return <div aria-hidden className="order-last h-5 sm:mt-8 sm:order-none" />;
  const bring = wallet.addresses ? null : wallet.bring;
  return (
    <div className="auni-stagger-in order-last mt-3 flex max-w-[680px] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 text-center text-meta text-muted-foreground sm:order-none sm:mt-8">
      <span className="inline-flex items-center gap-2">
        <AppMark id={ready.id} size={16} />
        <span>
          {ready.name} is ready.{" "}
          {wallet.addresses ? "So is your wallet." : "Your wallet is created with your first take."}
        </span>
      </span>
      {bring ? (
        <>
          <button
            type="button"
            onClick={() => setBringing(true)}
            className="font-medium text-ink-soft underline decoration-foreground/20 underline-offset-[3px] transition-colors hover:text-ink hover:decoration-current"
          >
            Bring an existing wallet
          </button>
          <BringWallet field={bring} open={bringing} onOpenChange={setBringing} />
        </>
      ) : null}
    </div>
  );
}
