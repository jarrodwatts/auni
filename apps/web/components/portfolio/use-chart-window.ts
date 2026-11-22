"use client";

import type { UsdcMoneyWire } from "@auni/shared";
import { useMemo, useState } from "react";

import { useMoney } from "@/components/money/money-provider";
import { useValueHistory } from "@/components/portfolio/use-portfolio";

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
 * Total portfolio chart period and scrub: the periods its history covers, the
 * line core draws for the chosen one, and the reading under the pointer.
 */
export function useChartWindow(live: LiveValue | null) {
  const [range, setRange] = useState<ChartRange>("1W");
  const [scrub, setScrub] = useState<ChartPoint | null>(null);
  const history = useValueHistory(range);
  const startedAt = history.data?.startedAt ?? null;
  const ranges = chartRanges(startedAt);
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
    move: scrub
      ? madeChange(measured.filter((reading) => reading.at <= Date.parse(scrub.observedAt)))
      : madeChange(measured),
    label: scrub ? dayLabel(scrub.observedAt, true) : moveLabel(range, drawn[0]?.observedAt),
  };
}
