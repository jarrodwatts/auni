"use client";

import "./conversation-welcome.css";

import { useCallback, useEffect, useRef, useState } from "react";

import { ComposerStandin } from "@/components/app/composer-shell";
import { NEW_TAKE_PLACEHOLDER, WelcomeComposer } from "@/components/app/welcome-composer";
import { StartingPoints } from "@/components/app/starting-points";
import {
  InteractiveMascot,
  type InteractiveMascotHandle,
  type MascotReadingTarget,
} from "@/components/brand/interactive-mascot";
import { useConversationLaunch } from "@/components/app/conversation-launch-context";
import { FirstTake } from "@/components/first-run/first-take";
import { useFirstRun } from "@/components/first-run/use-first-run";
import { useMe } from "@/components/personalization/use-me";
import { useArriving } from "@/components/places/arriving";
import { cn } from "@/lib/utils";

/** The preview is on screen, so the page taking its place has already made its entrance. */
let previewShowing = false;

/**
 * A new take: Auni, one question, and a few places to start from what Auni sees of the owner.
 * As a `preview` (the page's loading state) it looks the same but takes nothing in: the page
 * replacing it would drop a message sent from it, and would find a focus request already spent
 * on its box.
 */
export function ConversationWelcome({ preview = false }: { readonly preview?: boolean }) {
  const firstRun = useFirstRun();
  const { launch } = useConversationLaunch();
  const arriving = useArriving();
  // First run asks for the first take here, until its chat starts from it.
  if (firstRun) return preview ? null : <FirstTake />;
  if (arriving && launch) return null;
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
      {/* Wide, it all stands in the middle: Auni and the question, the box, then the points.
          On a phone the question and the points sit up top and the box waits at the thumb,
          over the tab bar: one set of points, moved by order. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-10 pb-3 sm:justify-center sm:px-8 sm:pt-8 sm:pb-24">
        <div className="flex flex-col items-center">
          <InteractiveMascot ref={mascotRef} size={64} className="size-14 sm:size-16" />
          <h1 className="mt-4 text-center text-title text-ink">
            {name ? `What's the take, ${name}?` : "What's the take?"}
          </h1>
        </div>
        <div className="order-last mt-auto w-full max-w-[680px] pt-6 sm:order-none sm:mt-8 sm:pt-0">
          {preview ? (
            <ComposerStandin placeholder={NEW_TAKE_PLACEHOLDER} />
          ) : (
            <WelcomeComposer onCaretActivity={trackCaret} />
          )}
        </div>
        <div className="mt-8 w-full max-w-[680px] sm:mt-4">
          <StartingPoints />
        </div>
      </div>
    </section>
  );
}
