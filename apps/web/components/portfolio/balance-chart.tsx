"use client";

import { useMemo } from "react";

import type { BalanceHistoryPoint } from "@/lib/data/views";

import { AUNI_HUE, DawnChart, type ChartHue } from "./dawn-chart";

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** "$1.02K" for the read-aloud label; an exact decimal string lets Intl round without losing precision. */
function compact(baseUnits: bigint): string {
  return compactUsd.format(`${baseUnits}e-6` as Intl.StringNumericLiteral);
}

export interface ChartPoint {
  readonly observedAt: string;
  readonly baseUnits: bigint;
  /** What it had made by then (see BalanceHistoryPoint), in base units. */
  readonly made: bigint;
}

/**
 * A line needs two readings. Today and the week are drawn on a grid, and a
 * month or more is offered only to an older history, so two is a specialist
 * that held money within one day: its line is how that day went.
 */
const MIN_POINTS = 2;

/** What a chart draws from a history, once there are enough readings for a line. */
export function chartPoints(history: readonly BalanceHistoryPoint[]): readonly ChartPoint[] {
  if (history.length < MIN_POINTS) return [];
  return history.map((point) => ({
    observedAt: point.observedAt,
    baseUnits: BigInt(point.totalUsd.baseUnits),
    made: BigInt(point.made.baseUnits),
  }));
}

/** Value over time as Auni's Dawn line; the page around it shows the period and the total. */
export function BalanceChart({
  points,
  label,
  height = 176,
  hue = AUNI_HUE,
  onScrub,
  className,
}: {
  readonly points: readonly BalanceHistoryPoint[];
  readonly label: string;
  readonly height?: number;
  readonly hue?: ChartHue;
  /** The reading under the pointer while scrubbing, or null. */
  readonly onScrub?: (point: ChartPoint | null) => void;
  readonly className?: string;
}) {
  const drawn = useMemo(() => chartPoints(points), [points]);
  const plotted = useMemo(
    () =>
      drawn.map((point) => ({ at: Date.parse(point.observedAt), value: Number(point.baseUnits) })),
    [drawn],
  );
  const first = drawn[0];
  const last = drawn.at(-1);
  if (!first || !last) return null;
  return (
    <DawnChart
      points={plotted}
      height={height}
      hue={hue}
      label={`${label}: from ${compact(first.baseUnits)} to ${compact(last.baseUnits)}.`}
      className={className}
      onScrub={onScrub && ((index) => onScrub(index === null ? null : (drawn[index] ?? null)))}
    />
  );
}
