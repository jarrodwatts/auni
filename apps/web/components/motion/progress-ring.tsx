"use client";

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import styles from "./progress-ring.module.css";
import { StatusMark, type Status } from "./status-mark";

/**
 * Legs of money through, as a ring: the arc grows round as each one lands,
 * with a faint arc turning over it while any is still going. Once all have
 * settled it closes into an ink disc with a tick, or a red disc with a cross
 * if any didn't go through. 16px in the sidebar, 18px beside a button's words.
 */
export function ProgressRing({
  done,
  total,
  status,
  size = 16,
}: {
  readonly done: number;
  readonly total: number;
  readonly status: Extract<Status, "now" | "done" | "failed">;
  readonly size?: 16 | 18;
}) {
  const share = total > 0 ? Math.min(done / total, 1) : 0;
  return (
    <StatusMark
      size={size}
      status={status}
      now={
        <>
          <span
            className={cn(styles.count, "absolute inset-0 rounded-full")}
            style={{ "--arc-length": `${share * 100}%` } as CSSProperties}
          />
          <span className={cn(styles.turning, "absolute inset-0 rounded-full")} />
        </>
      }
    />
  );
}
