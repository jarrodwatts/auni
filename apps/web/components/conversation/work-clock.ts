"use client";

import { useEffect, useRef, useState } from "react";

export function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  if (totalSeconds < 1) return "<1s";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 && `${hours}h`, minutes > 0 && `${minutes}m`, seconds > 0 && `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

/**
 * How long a settled turn worked: core's measure once it is stored, and until then
 * the clock that ran while it was watched.
 */
export function workHistoryLabel(input: {
  readonly elapsedMs: number | null;
  readonly workDurationMs: number | undefined;
}): string {
  const shownMs = Math.max(input.workDurationMs ?? 0, input.elapsedMs ?? 0);
  return shownMs > 0 ? `Worked for ${formatWorkDuration(shownMs)}` : "Worked";
}

function initialWorkMs(input: {
  readonly seenIdle: boolean;
  readonly startedAt: string | undefined;
  readonly nowMs: number;
}): number {
  if (input.seenIdle || input.startedAt === undefined) return 0;
  const sentAt = Date.parse(input.startedAt);
  return Number.isFinite(sentAt) ? Math.max(0, input.nowMs - sentAt) : 0;
}

export function useWorkClock(input: {
  readonly active: boolean;
  readonly startedAt?: string | undefined;
}): number | null {
  const { active, startedAt } = input;
  const ranRef = useRef(false);
  const seenIdleRef = useRef(false);
  const bankedMs = useRef(0);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      // Idle before this clock ever ran: there is no live stretch to backdate.
      seenIdleRef.current ||= !ranRef.current;
      return;
    }
    const resumedAt = Date.now();
    if (!ranRef.current) {
      ranRef.current = true;
      bankedMs.current = initialWorkMs({
        seenIdle: seenIdleRef.current,
        startedAt,
        nowMs: resumedAt,
      });
    }
    const read = () => bankedMs.current + (Date.now() - resumedAt);
    const tick = () => setElapsedMs(read());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => {
      window.clearInterval(timer);
      // Bank this stretch so the next one continues from here, not from the send.
      bankedMs.current = read();
      setElapsedMs(bankedMs.current);
    };
  }, [active, startedAt]);

  return elapsedMs;
}
