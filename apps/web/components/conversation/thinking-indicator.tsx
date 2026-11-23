"use client";

import { SpotlightShimmer } from "@/components/motion/spotlight-shimmer";
import { TextSwap } from "@/components/motion/text-swap";
import { ThinkingGlyph } from "@/components/motion/thinking-glyph";
import { cn } from "@/lib/utils";

import { LiveElapsed } from "./live-elapsed";

/**
 * Quiet, borderless typographic presence while the agent is thinking before any
 * tool step or prose arrives (or during a sustained mid-turn pause). Pairs Auni's
 * kinetic harmonic glyph with a unified spotlight sweep and a rolling elapsed timer
 * that softly fades in after the first second.
 */
export function ThinkingIndicator({
  active,
  animateEnter = false,
  label = "Thinking",
  primary = false,
  startedAt,
}: {
  readonly active: boolean;
  readonly animateEnter?: boolean;
  readonly label?: string;
  /** Marks the primary status line so the first-run landing dive can animate it. */
  readonly primary?: boolean;
  readonly startedAt?: string | undefined;
}) {
  return (
    <div
      aria-live={active ? "polite" : undefined}
      className={cn(
        "flex min-h-8 w-fit max-w-full min-w-0 items-center gap-2 py-1 text-[13.5px] font-[450] leading-5 tracking-[-0.005em] text-muted-foreground select-none",
        animateEnter && "auni-thinking-enter",
      )}
      data-slot={primary ? "work-history-trigger" : "thinking-indicator"}
    >
      <SpotlightShimmer active={active} className="min-w-0">
        <span className="inline-flex min-w-0 items-center gap-2">
          <ThinkingGlyph active={active} />
          <TextSwap text={label} />
        </span>
      </SpotlightShimmer>
      {active ? (
        <LiveElapsed
          className="flex-none text-[12.5px] font-normal text-faint"
          startedAt={startedAt}
        />
      ) : null}
    </div>
  );
}
