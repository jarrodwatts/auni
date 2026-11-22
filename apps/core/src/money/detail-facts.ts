import type { PickDetailWire } from "@auni/shared";

/**
 * What every pick's detail shares, whoever prices it (see pick-detail.ts and each venue's
 * `detail`): its line over about three months and the few numbers that matter for its kind.
 */

export type Fact = PickDetailWire["facts"][number];
type Point = PickDetailWire["points"][number];
export type Level = PickDetailWire["levels"][number];

export const DAY_MS = 86_400_000;
/** How far back a detail's line goes, in days. */
const SPAN_DAYS = 90;
/** How long a detail's history is kept, however often it is opened. */
export const DETAIL_TTL_MS = 10 * 60_000;
/** The card's facts sit in one row of two. */
const FACTS = 2;

/** When a detail's line starts. */
export function since(): number {
  return Date.now() - SPAN_DAYS * DAY_MS;
}

/** The first two facts a pick has, from a kind's list in order of what matters most. */
export function topFacts(facts: readonly (Fact | null | undefined)[]): Fact[] {
  return facts.filter((fact): fact is Fact => fact != null).slice(0, FACTS);
}

function percent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/** The change from `from` to `to`, in percent; null without a start. */
export function change(from: number | undefined, to: number): number | null {
  return from ? ((to - from) / from) * 100 : null;
}

export function quarterFact(points: readonly Point[], now: number): Fact | null {
  const quarter = change(points[0]?.value, now);
  return quarter === null ? null : { label: "3 months", value: percent(quarter) };
}

export function todayFact(today: number | null): Fact | null {
  return today === null ? null : { label: "Today", value: percent(today) };
}
