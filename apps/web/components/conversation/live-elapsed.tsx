"use client";

import { useEffect, useState } from "react";

import { RollingNumber } from "@/components/motion/rolling-number";
import { subscribeSecondTick } from "@/lib/tick-text";
import { cn } from "@/lib/utils";

import { formatLiveElapsed, parseStartMs } from "./work-clock";

/**
 * Leaf live elapsed counter backed by the shared 1-second clock: ticks only
 * itself (never re-rendering the surrounding turn), stays silent under 1s,
 * fades in softly, and rolls only the changing digit vertically.
 */
export function LiveElapsed({
  className,
  startedAt,
}: {
  readonly className?: string;
  readonly startedAt?: string | undefined;
}) {
  const [mountedAt] = useState(() => Date.now());
  const originMs = parseStartMs(startedAt, mountedAt);
  const [nowMs, setNowMs] = useState(mountedAt);

  useEffect(() => subscribeSecondTick(() => setNowMs(Date.now())), []);

  const formatted = formatLiveElapsed(originMs, nowMs);
  const shown = formatted.length > 0;

  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex items-baseline tabular-nums opacity-0 transition-opacity duration-300 ease-settle data-[shown=true]:opacity-100 motion-reduce:transition-none",
        className,
      )}
      data-shown={shown ? "true" : "false"}
    >
      {shown ? <RollingNumber value={formatted} /> : null}
    </span>
  );
}
