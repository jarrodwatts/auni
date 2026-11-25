"use client";

import { Check, CircleAlert, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { blurs, durations, easings, reducedMotion } from "@/lib/motion";
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

const BARE_LEAVE: Motion = {
  keyframes: [{ opacity: 0, transform: "scale(0.65)", filter: `blur(${blurs.subtle}px)` }],
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

const BARE_LAND: Motion = {
  keyframes: [
    { opacity: 0, transform: "scale(0.55)", filter: `blur(${blurs.subtle}px)` },
    { opacity: 1, transform: "none", filter: "blur(0px)" },
  ],
  options: { duration: 280, easing: OVERSHOOT },
};

const ARRIVE: Record<Status, Motion> = { waiting: APPEAR, now: APPEAR, done: LAND, failed: LAND };
const BARE_ARRIVE: Record<Status, Motion> = {
  waiting: APPEAR,
  now: APPEAR,
  done: BARE_LAND,
  failed: BARE_LAND,
};

/** How a glyph leaves and arrives, for a slot that hands over between marks of its own. */
export const glyphMotion = { leave: LEAVE, appear: APPEAR } as const;

const GLYPH: Record<Status, string | undefined> = {
  waiting: "border-[1.5px] border-dashed border-ink/[0.2]",
  now: styles.arc,
  done: "flex items-center justify-center bg-ink text-background",
  failed: "flex items-center justify-center bg-negative text-background",
};

const BARE_GLYPH: Record<Status, string | undefined> = {
  waiting: "border-[1.5px] border-dashed border-ink/[0.2]",
  now: styles.arcThin,
  done: "flex items-center justify-center text-ink",
  failed: "flex items-center justify-center text-negative",
};

/**
 * A step's status as one small glyph: a dashed ring while it waits, a
 * turning arc while it runs, an ink disc with a tick once done (or a bare
 * ink check on chat step rows: green is money's), and red if it didn't go
 * through. A change
 * hands over: the old glyph shrinks away as the new one pops in. 14px beside
 * chat steps, 16px in the sidebar, 18px on cards.
 */
export function StatusMark({
  size = 18,
  status,
  now,
  variant = "disc",
}: {
  readonly size?: 14 | 16 | 18;
  readonly status: Status;
  /** Drawn while it runs, in place of the turning arc: ProgressRing's count. */
  readonly now?: ReactNode;
  /** `disc` fills a solid badge (cards, sidebar); `bare` draws crisp stroke icons (chat rows). */
  readonly variant?: "disc" | "bare";
}) {
  const [swap, setSwap] = useState(() => swapOf(status));
  if (swap.current !== status) setSwap(swapTo(swap, status, !reducedMotion()));
  const bare = variant === "bare";
  const copy = useHandover(
    swap,
    setSwap,
    bare ? BARE_LEAVE : LEAVE,
    bare ? BARE_ARRIVE[swap.current] : ARRIVE[swap.current],
  );
  const mark = bare ? "size-3.5" : size === 14 ? "size-2" : "size-2.5";
  const glyphStyles = bare ? BARE_GLYPH : GLYPH;

  const copies = [...swap.leaving, { id: swap.id, value: swap.current }];
  return (
    <span aria-hidden className="relative block flex-none" style={{ height: size, width: size }}>
      {copies.map(({ id, value }) => (
        <span
          key={id}
          ref={copy(id)}
          className={cn(
            "absolute inset-0 rounded-full",
            value === "now" && now ? null : glyphStyles[value],
          )}
        >
          {value === "done" ? (
            <Check className={mark} strokeWidth={bare ? 2.25 : 3.4} />
          ) : value === "failed" ? (
            bare ? (
              <CircleAlert className={mark} strokeWidth={1.85} />
            ) : (
              <X className={mark} strokeWidth={3.4} />
            )
          ) : value === "now" ? (
            now
          ) : null}
        </span>
      ))}
    </span>
  );
}
