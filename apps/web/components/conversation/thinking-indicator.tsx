"use client";

import "./thinking-indicator.css";

import { Mascot } from "@/components/brand/mascot";
import { SpotlightShimmer } from "@/components/motion/spotlight-shimmer";
import { TextSwap } from "@/components/motion/text-swap";
import { observeVisibleAnimation } from "@/lib/visible-animation";

/**
 * Auni at work with nothing else to show yet: its mascot, breathing, and what it's doing in
 * a few words ("Thinking", "Checking your money"). No timer: how long it has taken is nothing
 * the owner needs.
 */
export function ThinkingIndicator({
  active,
  label = "Thinking",
}: {
  readonly active: boolean;
  readonly label?: string;
}) {
  return (
    <div
      aria-live={active ? "polite" : undefined}
      className="flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 text-ui text-muted-foreground select-none"
      data-slot="thinking-indicator"
    >
      <span
        aria-hidden
        className="auni-thinking-mascot"
        data-active={active || undefined}
        ref={active ? observeVisibleAnimation : undefined}
      >
        <Mascot alt="" eager size={20} state="thinking" />
      </span>
      <SpotlightShimmer active={active} className="min-w-0">
        <TextSwap text={label} />
      </SpotlightShimmer>
    </div>
  );
}
