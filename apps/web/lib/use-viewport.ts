"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** The media query for a person who asked their device for less motion. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether a media query matches; false on the server and at first paint. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  );
}

/**
 * How much of the layout viewport the on-screen keyboard covers, so a sheet
 * pinned to the bottom can ride above it. Zero without a keyboard.
 */
export function useKeyboardInset(active: boolean): { inset: number; visible: number | null } {
  const [state, setState] = useState<{ inset: number; visible: number | null }>({
    inset: 0,
    visible: null,
  });
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    const measure = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      // Under 80px is browser chrome settling, not a keyboard.
      setState(inset > 80 ? { inset, visible: viewport.height } : { inset: 0, visible: null });
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, [active]);
  return active ? state : { inset: 0, visible: null };
}
