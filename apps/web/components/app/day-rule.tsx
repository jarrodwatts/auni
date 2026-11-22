import { shortDate } from "@/lib/dates";
import type { AuniUiMessage } from "@/lib/conversation";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" });

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function sentAt(message: AuniUiMessage | undefined): number | null {
  const at = message?.metadata?.createdAt;
  return at ? Date.parse(at) : null;
}

/**
 * A place keeps one conversation for good, so it reads split by day. A new
 * day gets a rule; a conversation that is all today needs none.
 */
export function dayLabel(
  message: AuniUiMessage,
  previous: AuniUiMessage | undefined,
  now = Date.now(),
): string | null {
  const at = sentAt(message);
  if (at === null) return null;
  const day = startOfDay(at);
  const previousAt = sentAt(previous);
  if (previous && (previousAt === null || startOfDay(previousAt) === day)) return null;
  const today = startOfDay(now);
  if (day === today) return previous ? "Today" : null;
  const daysAgo = Math.round((today - day) / DAY_MS);
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo < 7) return WEEKDAY.format(at);
  return shortDate(at, now);
}

export function DayRule({ label }: { readonly label: string | null }) {
  if (!label) return null;
  return (
    <div
      role="separator"
      aria-label={label}
      className="mb-7 flex items-center gap-4 text-[12.5px] font-medium text-faint"
    >
      <span aria-hidden className="h-px flex-1 bg-foreground/[0.07]" />
      {label}
      <span aria-hidden className="h-px flex-1 bg-foreground/[0.07]" />
    </div>
  );
}
