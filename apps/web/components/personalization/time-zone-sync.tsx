"use client";

import { currentZoneName } from "@auni/shared";
import { useEffect } from "react";

import { useMe, useUpdateMe } from "./use-me";

/**
 * Keeps the account's time zone the browser's, so "today" starts at the
 * person's own midnight wherever they open Auni, and Auni knows their time.
 * Saved only when it differs; a save that fails isn't tried again until the
 * next visit.
 */
export function TimeZoneSync() {
  const { timeZone } = useMe();
  const { mutate, isIdle } = useUpdateMe();

  useEffect(() => {
    // By its current name, as core saves it, so an old one isn't saved again each visit.
    const zone = currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (zone && zone !== timeZone && isIdle) mutate({ time_zone: zone });
  }, [timeZone, mutate, isIdle]);

  return null;
}
