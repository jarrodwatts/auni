"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Money cards that would have Auni over their edge, and the newest of them,
 * the one furthest down the page. Auni keeps one card company at a time.
 */
const wanting = new Set<HTMLElement>();
const listeners = new Set<() => void>();
let newest: HTMLElement | null = null;

function choose() {
  let latest: HTMLElement | null = null;
  for (const card of wanting) {
    if (!latest || latest.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) {
      latest = card;
    }
  }
  if (latest === newest) return;
  newest = latest;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether `card` is the newest card that wants Auni. One that would have Auni
 * `come` waits its turn; one that would only `keep` it holds on while it's the
 * newest, and once Auni leaves it for a newer card it is out for good.
 */
export function useNewestCard(card: HTMLElement | null, wants: "come" | "keep" | null): boolean {
  const hosting = useSyncExternalStore(
    subscribe,
    () => card !== null && newest === card,
    () => false,
  );
  const joined = wants === "come" || (wants === "keep" && hosting);
  // Before paint, so a card never draws a frame without the Auni it's about to have.
  useLayoutEffect(() => {
    if (!card || !joined) return undefined;
    wanting.add(card);
    choose();
    return () => {
      wanting.delete(card);
      choose();
    };
  }, [card, joined]);
  return hosting;
}
