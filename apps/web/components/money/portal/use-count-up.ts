"use client";

import { useEffect, useRef, useState } from "react";

const CENT = 10_000n;
const DOLLAR = 1_000_000n;

/**
 * USDC base units part way through counting from `from` to `to`, exact once `elapsedMs` reaches
 * `durationMs`, quickly at first. It climbs in the steps the amount itself is in: whole dollars
 * to a whole amount, so the figure never flickers through cents it won't have, and cents
 * otherwise, so it never widens at the end. Once counting starts it is never zero, so a $1 test
 * send never reads "$0".
 */
export function countUpAt(to: bigint, elapsedMs: number, durationMs: number, from = 0n): bigint {
  if (elapsedMs >= durationMs) return to;
  const step = to % DOLLAR === 0n ? DOLLAR : CENT;
  const eased = 1 - (1 - Math.max(0, elapsedMs) / durationMs) ** 3;
  const climbed = ((from + ((to - from) * BigInt(Math.round(eased * 1000))) / 1000n) / step) * step;
  return climbed > 0n ? climbed : step < to ? step : to;
}

/**
 * `target` counted up to, starting `delayMs` from now: from zero, or from the figure shown when a
 * later target takes its place; at once where motion is reduced. Null until the count starts, so
 * nothing reads "$0" while it waits.
 */
export function useCountUp(
  target: bigint | null,
  durationMs: number,
  delayMs: number,
): bigint | null {
  const [shown, setShown] = useState<bigint | null>(null);
  // What shows now, read when the target changes, so the count goes on from there.
  const showing = useRef(0n);
  useEffect(() => {
    if (target === null) return;
    const from = showing.current;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now() + (reduce ? 0 : delayMs);
    let frame = requestAnimationFrame(function step(now) {
      const elapsed = reduce ? durationMs : now - start;
      if (elapsed >= 0) {
        showing.current = countUpAt(target, elapsed, durationMs, from);
        setShown(showing.current);
      }
      if (elapsed < durationMs) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [delayMs, durationMs, target]);
  return shown;
}
