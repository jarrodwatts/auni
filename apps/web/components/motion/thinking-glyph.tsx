"use client";

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { observeVisibleAnimation } from "@/lib/visible-animation";

/**
 * Bespoke precision kinetic glyph for Auni's thinking state: four micro nodes
 * arranged in a harmonic diamond that breathe in phase around a slow orbital
 * drift. Pure compositor transforms, paused off-screen and still under reduced motion.
 */
export function ThinkingGlyph({
  active = true,
  className,
}: {
  readonly active?: boolean;
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={cn("auni-thinking-glyph size-4 shrink-0", className)}
      data-active={active || undefined}
      fill="none"
      ref={active ? observeVisibleAnimation : undefined}
      viewBox="0 0 16 16"
    >
      <g className="auni-thinking-orbit">
        <circle className="auni-thinking-node" cx="8" cy="3.2" r="1.55" style={{ "--n": 0 } as CSSProperties} />
        <circle className="auni-thinking-node" cx="12.8" cy="8" r="1.55" style={{ "--n": 1 } as CSSProperties} />
        <circle className="auni-thinking-node" cx="8" cy="12.8" r="1.55" style={{ "--n": 2 } as CSSProperties} />
        <circle className="auni-thinking-node" cx="3.2" cy="8" r="1.55" style={{ "--n": 3 } as CSSProperties} />
      </g>
    </svg>
  );
}
