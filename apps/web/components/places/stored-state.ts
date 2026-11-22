"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Small per-viewer memories kept in localStorage: whether the sidebar is a
 * rail, whether the thread inspector pane is open, whether Auni's thinking
 * shows, and recently visited places.
 * Storage can be blocked or empty; everything still works on the defaults.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the choice lasts until the page closes.
  }
  for (const listener of listeners) listener();
}

/** A remembered on/off; the server and first paint use the fallback. */
export function useStoredFlag(key: string, fallback: boolean) {
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const value = stored === null ? fallback : stored === "1";
  const set = useCallback((next: boolean) => write(key, next ? "1" : "0"), [key]);
  return [value, set] as const;
}

/** A remembered word, such as which look is picked; null until one is. */
export function useStoredChoice(key: string) {
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const set = useCallback((next: string | null) => write(key, next ?? ""), [key]);
  return [stored || null, set] as const;
}

/** Whether chat shows Auni's reasoning between its steps; on until the person turns it off. */
export function useShowThinking() {
  return useStoredFlag("auni:show-thinking", true);
}

const RECENT_KEY = "auni:recent-places";
const MAX_RECENT = 8;

/** The paths of the places opened last, newest first: what search offers before anything is typed. */
export function useRecentPlaces(): readonly string[] {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(RECENT_KEY) ?? "",
    () => "",
  );
  return useMemo(() => raw.split("\n").filter(Boolean), [raw]);
}

export function rememberRecentPlace(path: string): void {
  const recent = (read(RECENT_KEY) ?? "").split("\n").filter(Boolean);
  if (recent[0] === path) return;
  const next = [path, ...recent.filter((kept) => kept !== path)].slice(0, MAX_RECENT);
  write(RECENT_KEY, next.join("\n"));
}
