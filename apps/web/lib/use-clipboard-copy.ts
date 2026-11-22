"use client";

import { useEffect, useRef, useState } from "react";

const CONFIRMATION_MILLISECONDS = 2_000;

interface ClipboardCopy {
  /** The value confirmed most recently, so several buttons can share one state. */
  readonly copiedValue: string | null;
  /** True when the browser refused clipboard access and the person must select by hand. */
  readonly blocked: boolean;
  readonly copy: (value: string) => void;
}

export function useClipboardCopy(): ClipboardCopy {
  const resetRef = useRef<number | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    },
    [],
  );

  const copy = (value: string) => {
    if (!navigator.clipboard?.writeText) {
      setBlocked(true);
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setBlocked(false);
        setCopiedValue(value);
        if (resetRef.current !== null) window.clearTimeout(resetRef.current);
        resetRef.current = window.setTimeout(() => setCopiedValue(null), CONFIRMATION_MILLISECONDS);
      })
      .catch(() => {
        setCopiedValue(null);
        setBlocked(true);
      });
  };

  return { blocked, copiedValue, copy };
}
