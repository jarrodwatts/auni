"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ComposerStandin } from "@/components/app/composer-shell";
import { WelcomeComposer } from "@/components/app/welcome-composer";
import { StartingPoints } from "@/components/app/starting-points";
import { Lockup } from "@/components/brand/lockup";
import {
  InteractiveMascot,
  type InteractiveMascotHandle,
  type MascotReadingTarget,
} from "@/components/brand/interactive-mascot";
import { useConversationLaunch } from "@/components/app/conversation-launch-context";
import { useFirstRun } from "@/components/first-run/use-first-run";
import { useMe } from "@/components/personalization/use-me";
import { useArriving } from "@/components/places/arriving";
import { BackToPortfolio } from "@/components/places/place-header";
import { cn } from "@/lib/utils";

/** The preview is on screen, so the page taking its place has already made its entrance. */
let previewShowing = false;

/**
 * A new chat: Auni, one question, and a few places to start from what Auni sees of the owner.
 * As a `preview` (the page's loading state) it looks the same but takes nothing in: the page
 * replacing it would drop a message sent from it, and would find a focus request already spent
 * on its box.
 */
export function ConversationWelcome({ preview = false }: { readonly preview?: boolean }) {
  const firstRun = useFirstRun();
  const { launch } = useConversationLaunch();
  const arriving = useArriving();
  // First run is the landing, over the app (PlaceWorkspace), until the first take's chat starts
  // from it: nothing here is drawn under it meanwhile.
  if (firstRun || (arriving && launch)) return null;
  return <NewChat preview={preview} />;
}

function NewChat({ preview }: { readonly preview: boolean }) {
  const { name } = useMe();
  const [entering] = useState(() => preview || !previewShowing);
  useEffect(() => {
    if (!preview) return undefined;
    previewShowing = true;
    return () => {
      previewShowing = false;
    };
  }, [preview]);
  const mascotRef = useRef<InteractiveMascotHandle>(null);
  const trackCaret = useCallback((target: MascotReadingTarget) => {
    mascotRef.current?.trackCaret(target);
  }, []);

  return (
    // The preview takes no input at all: a tap on it would land on controls about to be
    // replaced, and its back link could cancel the navigation it stands in for.
    <section
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-background",
        entering && "auni-new-conversation-enter",
      )}
      inert={preview}
      aria-busy={preview}
    >
      <div className="flex h-[56px] flex-none items-center gap-2 border-b border-foreground/[0.06] px-3 lg:hidden">
        <BackToPortfolio preview={false} />
        <Lockup height={18} />
      </div>
      {/* On a phone the starting points sit just above the box, at the bottom where a thumb is,
          and Auni fills the space above them; wider, all of it stands in the middle, the points
          under the box. One set of points, moved by order. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-8 pb-4 sm:justify-center sm:px-8 sm:pb-20">
        <div className="flex flex-1 flex-col items-center justify-center pb-6 sm:flex-none sm:pb-0">
          <InteractiveMascot ref={mascotRef} size={104} className="size-22 sm:size-[104px]" />
          <h1 className="mt-4 text-center text-[25px] font-bold tracking-[-0.025em] text-ink sm:text-[29px]">
            {name ? `Where should we start, ${name}?` : "What do you want to explore?"}
          </h1>
          {/* On a phone the heading says it alone, and the points get the room. */}
          <p className="mt-2 hidden max-w-[520px] text-center text-[15px] leading-[1.5] text-muted-foreground sm:block">
            Ask a question, test a take, or start from one of the live ideas below.
          </p>
        </div>
        <div className="order-last mt-2 w-full max-w-[680px] sm:order-none sm:mt-8">
          {preview ? (
            <ComposerStandin placeholder="Peptides go mainstream by 2028" />
          ) : (
            <WelcomeComposer onCaretActivity={trackCaret} />
          )}
        </div>
        <div className="w-full max-w-[680px] sm:mt-3">
          <StartingPoints />
        </div>
      </div>
    </section>
  );
}
