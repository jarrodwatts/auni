import type { Take } from "@/lib/data/takes";
import { formatUsdcChange } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * What a take made since it was bought, in its gain or loss colour: "+$232.29 (8.6%)". Your
 * takes says "Change since entry" over them all, so it is never read as the day's move the
 * sidebar shows; a screen reader hears it on each.
 */
export function TakeChange({
  change,
  className,
}: {
  readonly change: NonNullable<Take["change"]>;
  readonly className?: string;
}) {
  // Toned by the rounded amount, so a move under a cent reads as no move at all.
  const amount = formatUsdcChange(change.amount);
  const up = amount.startsWith("+");
  const down = !up && !amount.startsWith("$");
  return (
    <span
      className={cn(
        "whitespace-nowrap tabular-nums",
        up ? "text-positive" : down ? "text-negative" : "text-muted-foreground",
        className,
      )}
    >
      {amount} ({Math.abs(change.percent).toFixed(1)}%)
      <span className="sr-only"> since entry</span>
    </span>
  );
}
