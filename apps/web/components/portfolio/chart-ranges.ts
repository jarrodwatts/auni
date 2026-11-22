import type { ValueRange } from "@auni/shared";

import { shortDate } from "@/lib/dates";

/** How far back a chart looks. Only periods the history actually covers are offered. */
export type ChartRange = ValueRange;

const RANGE_DAYS: Readonly<Record<Exclude<ChartRange, "All">, number>> = {
  Today: 1,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "1Y": 365,
};
const DAY_MS = 24 * 60 * 60 * 1_000;

/** What each period is called under the number it moves. */
const RANGE_LABEL: Readonly<Record<ChartRange, string>> = {
  Today: "Today",
  "1W": "Past week",
  "1M": "Past month",
  "3M": "Past 3 months",
  "1Y": "Past year",
  All: "All time",
};

/**
 * The periods worth offering a history that first held money at `startedAt`:
 * each one up to the first that already shows everything, so a month of
 * history never offers a "1Y" that looks the same. None for one that never did.
 */
export function chartRanges(startedAt: string | null): ChartRange[] {
  if (!startedAt) return [];
  const started = Date.parse(startedAt);
  const span = (Date.now() - started) / DAY_MS;
  const ranges: ChartRange[] = [];
  for (const [range, days] of Object.entries(RANGE_DAYS) as [ChartRange, number][]) {
    ranges.push(range);
    // Core cuts each period off exactly: Today at midnight, so money first held last night needs
    // the week, however recent, and the week at seven days.
    const showsAll = range === "Today" ? started >= startOfToday() : span <= days;
    if (showsAll) return ranges;
  }
  return [...ranges, "All"];
}

function startOfToday(): number {
  return new Date().setHours(0, 0, 0, 0);
}

/** Whether a move counted from `from` reaches back the whole period, so its name is true: Today from midnight. */
function coversRange(from: number, range: ChartRange): boolean {
  if (range === "All") return true;
  if (range === "Today") return from <= startOfToday();
  return Date.now() - from >= RANGE_DAYS[range] * 0.9 * DAY_MS;
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** "Oct 21", or "Oct 21, 7:45 PM" within a day. */
export function dayLabel(observedAt: string, intraday: boolean): string {
  const day = shortDate(observedAt);
  return intraday ? `${day}, ${TIME.format(new Date(observedAt))}` : day;
}

/**
 * What a chart's move is over, named from its first drawn point, `from`,
 * where the move counts from: the period, or where it starts when that is
 * later ("Since Oct 21"), as for a history younger than the period.
 */
export function moveLabel(range: ChartRange, from: string | undefined): string {
  return !from || coversRange(Date.parse(from), range)
    ? RANGE_LABEL[range]
    : `Since ${dayLabel(from, range === "Today")}`;
}

/**
 * A week first: long enough to show how money is doing, short enough that
 * one old move doesn't flatten everything since. A younger history has only Today.
 */
export function defaultChartRange(ranges: readonly ChartRange[]): ChartRange {
  return ranges.includes("1W") ? "1W" : (ranges.at(-1) ?? "1W");
}
