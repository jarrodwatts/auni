"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { observeVisibleAnimation } from "@/lib/visible-animation";

/**
 * Dual-layer spotlight sweep: renders a calm muted base layer and, while `active`,
 * glides a soft masked foreground highlight across both icons and text together
 * on the compositor. Always keeps the same base tree depth so child transitions
 * (such as `TextSwap`) never unmount when work finishes.
 */
export function SpotlightShimmer({
  active,
  children,
  className,
  highlightClassName = "text-ink",
}: {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly highlightClassName?: string;
}) {
  return (
    <span
      ref={active ? observeVisibleAnimation : undefined}
      className={cn("auni-spotlight", className)}
      data-active={active || undefined}
    >
      <span className="auni-spotlight-base">{children}</span>
      {active ? (
        <span aria-hidden className="auni-spotlight-overlay">
          <span className="auni-spotlight-counter">
            <span className={cn("auni-spotlight-aligned", highlightClassName)}>{children}</span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
