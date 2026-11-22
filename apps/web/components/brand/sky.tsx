"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * The soft sky first run opens under, with a faint grid that clears away around the question:
 * behind the landing, and behind the moment before it while core says whose browser this is.
 */
export function Sky() {
  const ref = useRef<HTMLDivElement>(null);

  // Every sky drifts on the page's one clock, so the sky a route change mounts picks up
  // exactly where the last one was instead of restarting its drift.
  useLayoutEffect(() => {
    for (const animation of ref.current?.getAnimations({ subtree: true }) ?? [])
      animation.startTime = 0;
  }, []);

  return (
    <div ref={ref} aria-hidden className="auni-sky">
      <span className="auni-sky-glow auni-sky-glow-a" />
      <span className="auni-sky-glow auni-sky-glow-b" />
      <span className="auni-sky-glow auni-sky-glow-c" />
      <span className="auni-sky-grid" />
    </div>
  );
}
