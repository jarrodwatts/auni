"use client";

import type { SpecialistId, UsdcMoneyWire } from "@auni/shared";
import { useMemo, useState } from "react";

import { useValueHistory } from "@/components/specialist/use-specialists";
import { useMoney } from "@/components/money/money-provider";

import { chartPoints, type ChartPoint } from "./balance-chart";
import { madeChange, type MadeReading } from "./made-change";
import {
  chartRanges,
  dayLabel,
  defaultChartRange,
  moveLabel,
  type ChartRange,
} from "./chart-ranges";
import { endingLive, type LiveValue } from "./live-end";

/**
 * The number on screen, its value and what it has made, as its line's end
 * (see endingLive); none while some source couldn't be read, as the number
 * then leaves that money out and a line ending in it would draw a drop that
 * didn't happen, so the line ends where core's readings do.
 */
export function useLiveEnd(
  value: UsdcMoneyWire | undefined,
  made: UsdcMoneyWire | undefined,
): LiveValue | null {
  const partial = useMoney().portfolio?.partial === true;
  return useMemo(
    () =>
      partial || !value || !made
        ? null
        : { value: BigInt(value.baseUnits), made: BigInt(made.baseUnits) },
    [partial, value, made],
  );
}

/**
 * One chart's period and scrub, for the account (no specialist) or one
 * specialist: the periods its history covers, the line core draws for the
 * chosen one, and the reading under the pointer, if any. The number above
 * the chart follows the scrub; its move is what was made since the first
 * drawn point, named for the period, the scrubbed day, or where that point
 * is (see moveLabel). The line ends in `live` (see useLiveEnd).
 */
export function useChartWindow(specialistId: SpecialistId | null, live: LiveValue | null) {
  const [range, setRange] = useState<ChartRange>("1W");
  const [scrub, setScrub] = useState<ChartPoint | null>(null);
  const history = useValueHistory(specialistId, range);
  const startedAt = history.data?.startedAt ?? null;
  // Not memoised: which periods show everything moves on at midnight, though startedAt doesn't.
  const ranges = chartRanges(startedAt);
  // The week is the first look; once its history says it is younger than that, Today.
  if (history.data && !history.isPlaceholderData && ranges.length > 0 && !ranges.includes(range))
    setRange(defaultChartRange(ranges));
  const points = useMemo(() => endingLive(history.data?.points ?? [], live), [history.data, live]);
  const drawn = useMemo(() => chartPoints(points), [points]);
  const measured = useMemo(
    () =>
      drawn.map((point): MadeReading => ({
        at: Date.parse(point.observedAt),
        value: point.baseUnits,
        made: point.made,
      })),
    [drawn],
  );
  return {
    ranges,
    range,
    setRange,
    points,
    scrub,
    setScrub,
    /** What was made up to the scrubbed point, or the line's end; null when it can't be told. */
    move: scrub
      ? madeChange(measured.filter((reading) => reading.at <= Date.parse(scrub.observedAt)))
      : madeChange(measured),
    /** The scrubbed reading's date, or what the move is over (see moveLabel). */
    label: scrub ? dayLabel(scrub.observedAt, true) : moveLabel(range, drawn[0]?.observedAt),
  };
}
