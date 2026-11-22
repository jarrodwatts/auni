import type { ActivityItemWire } from "@auni/shared";

import { formatUsd } from "@/lib/money";

interface ActivityGroup {
  readonly label: string;
  readonly items: readonly ActivityItemWire[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

/**
 * Newest-first items under the headings the list reads by: the past seven
 * days, then the rest of this month, then each month before it, with its
 * year once it isn't this one's.
 */
export function activityGroups(
  items: readonly ActivityItemWire[],
  now: number,
): readonly ActivityGroup[] {
  const today = new Date(now);
  const groups: { label: string; items: ActivityItemWire[] }[] = [];
  for (const item of items) {
    const at = new Date(item.at);
    const label =
      now - at.getTime() < WEEK_MS
        ? "This week"
        : at.getFullYear() !== today.getFullYear()
          ? MONTH_YEAR.format(at)
          : at.getMonth() === today.getMonth()
            ? `Earlier in ${MONTH.format(at)}`
            : MONTH.format(at);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

const MINUS = "−";

/** "+$50" in, "−$5.26" out, "$16.50" for a buy, which is neither. */
export function amountText(amount: NonNullable<ActivityItemWire["amount"]>): string {
  const sign = amount.direction === "in" ? "+" : amount.direction === "out" ? MINUS : "";
  return `${sign}${formatUsd(amount.usd)}`;
}

/** Green for money in or a gain, red for a loss, ink otherwise. */
export const TONE_CLASS_NAME: Readonly<
  Record<NonNullable<ActivityItemWire["amount"]>["tone"], string>
> = {
  gain: "text-positive",
  loss: "text-negative",
  neutral: "text-ink",
};
