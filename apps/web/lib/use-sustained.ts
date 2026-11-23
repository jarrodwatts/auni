"use client";

import { useEffect, useState } from "react";

const UNSET = Symbol("unset");

/**
 * True once `value` has held with an unchanged `resetKey` for `ms`, and false
 * synchronously the moment `value` turns false or `resetKey` changes.
 */
export function useSustained(value: boolean, ms: number, resetKey?: unknown): boolean {
  const [heldKey, setHeldKey] = useState<unknown>(UNSET);
  useEffect(() => {
    if (!value) return undefined;
    const timer = window.setTimeout(() => setHeldKey(resetKey), ms);
    return () => {
      window.clearTimeout(timer);
      setHeldKey(UNSET);
    };
  }, [ms, resetKey, value]);
  return value && heldKey === resetKey;
}
