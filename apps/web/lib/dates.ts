const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Jun 12", or "Jun 12, 2025" outside this year, the same on the server and the client. */
export function shortDate(at: string | number, now = Date.now()): string {
  const date = new Date(at);
  return date.getFullYear() === new Date(now).getFullYear()
    ? SHORT_DATE.format(date)
    : LONG_DATE.format(date);
}
