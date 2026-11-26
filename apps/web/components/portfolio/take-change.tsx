import type { Take } from "@/lib/data/takes";
import { formatUsdcChange } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * What a take or one of its holdings made since it was bought, in its gain or loss colour:
 * "+$232.29 (8.6%)". Your takes says "Change since entry" over them all, so it is never read as
 * the day's move the sidebar shows; a screen reader hears it on each. Savings made only what
 * they earned: "+$15.02 earned", or "No interest yet".
 */
export function TakeChange({
  change,
  savings = false,
  className,
}: {
  readonly change: NonNullable<Take["change"]>;
  readonly savings?: boolean;
  readonly className?: string;
}) {
  // Toned by the rounded amount, so a move under a cent reads as no move at all.
  const amount = formatUsdcChange(change.amount);
  const up = amount.startsWith("+");
  if (savings) {
    return (
      <span
        className={cn(
          "whitespace-nowrap tabular-nums",
          up ? "text-positive" : "text-muted-foreground",
          className,
        )}
      >
        {up ? `${amount} earned` : "No interest yet"}
      </span>
    );
  }
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
