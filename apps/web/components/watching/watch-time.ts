const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DAY_MS = 24 * 60 * 60 * 1_000;

/** "Today, 2:14 PM", "Yesterday, 9:00 AM", then "Sep 18" (or "Sep 18, 2:14 PM" with `time`). */
export function spokeAt(iso: string, time = false, now = new Date()): string {
  const at = new Date(iso);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (at >= midnight) return `Today, ${TIME.format(at)}`;
  if (at.getTime() >= midnight.getTime() - DAY_MS) return `Yesterday, ${TIME.format(at)}`;
  return time ? `${DAY.format(at)}, ${TIME.format(at)}` : DAY.format(at);
}

/** Whether it happened since midnight here. */
export function isToday(iso: string, now = new Date()): boolean {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Date.parse(iso) >= midnight.getTime();
}
