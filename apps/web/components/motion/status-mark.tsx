"use client";

import { Check, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { durations, easings, reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

import styles from "./status-mark.module.css";
import { swapOf, swapTo } from "./swap";
import { useHandover, type Motion } from "./use-handover";

/** Where a step is: still to come, under way, done, or didn't go through. */
export type Status = "waiting" | "now" | "done" | "failed";

/** A tick or cross lands with a little give, overshooting before it rests. */
const OVERSHOOT = "cubic-bezier(0.34, 1.56, 0.64, 1)";

const LEAVE: Motion = {
  keyframes: [{ opacity: 0, transform: "scale(0.6)" }],
  options: { duration: durations.fast, easing: easings.settle },
};

const APPEAR: Motion = {
  keyframes: [
    { opacity: 0, transform: "scale(0.7)" },
    { opacity: 1, transform: "none" },
  ],
  options: { duration: durations.standard, easing: easings.drift },
};

const LAND: Motion = {
  keyframes: [
    { opacity: 0, transform: "scale(0.4) rotate(-20deg)" },
    { opacity: 1, transform: "none" },
  ],
  options: { duration: durations.considered, easing: OVERSHOOT },
};

const ARRIVE: Record<Status, Motion> = { waiting: APPEAR, now: APPEAR, done: LAND, failed: LAND };

/** How a glyph leaves and arrives, for a slot that hands over between marks of its own. */
export const glyphMotion = { leave: LEAVE, appear: APPEAR } as const;

const GLYPH: Record<Status, string | undefined> = {
  waiting: "border-[1.5px] border-dashed border-ink/[0.2]",
  now: styles.arc,
  done: "flex items-center justify-center bg-ink text-background",
  failed: "flex items-center justify-center bg-negative text-background",
};

/**
 * A step's status as one small glyph: a dashed ring while it waits, a
 * turning arc while it runs, an ink disc with a tick once done, a red disc
 * with a cross if it didn't go through. A change hands over: the old glyph
 * shrinks away as the new one pops in. 14px beside chat steps, 16px in the
 * sidebar, 18px on cards.
 */
export function StatusMark({
  size = 18,
  status,
  now,
}: {
  readonly size?: 14 | 16 | 18;
  readonly status: Status;
  /** Drawn while it runs, in place of the turning arc: ProgressRing's count. */
  readonly now?: ReactNode;
}) {
  const [swap, setSwap] = useState(() => swapOf(status));
  if (swap.current !== status) setSwap(swapTo(swap, status, !reducedMotion()));
  const copy = useHandover(swap, setSwap, LEAVE, ARRIVE[swap.current]);
  const mark = size === 14 ? "size-2" : "size-2.5";

  const copies = [...swap.leaving, { id: swap.id, value: swap.current }];
  return (
    <span aria-hidden className="relative block flex-none" style={{ height: size, width: size }}>
      {copies.map(({ id, value }) => (
        <span
          key={id}
          ref={copy(id)}
          className={cn(
            "absolute inset-0 rounded-full",
            value === "now" && now ? null : GLYPH[value],
          )}
        >
          {value === "done" ? (
            <Check className={mark} strokeWidth={3.4} />
          ) : value === "failed" ? (
            <X className={mark} strokeWidth={3.4} />
          ) : value === "now" ? (
            now
          ) : null}
        </span>
      ))}
    </span>
  );
}
