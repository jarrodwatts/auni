import { formatUsdcChange } from "@/lib/money";
import { cn } from "@/lib/utils";

import { RollingNumber } from "./rolling-number";

/**
 * What the holdings made or lost over the chart's period (see madeChange), and over what:
 * "+$88.63 (0.5%) made in the past week", "−$0.94 (5.2%) lost today". Money put in or taken
 * out moves the account value beside it, never this.
 */
export function ChartChange({
  move,
  label,
  className,
}: {
  readonly move: { readonly change: bigint; readonly percent: number };
  readonly label: string;
  readonly className?: string;
}) {
  // Toned by the rounded amount, so a move under a cent reads as no move at all.
  const amount = formatUsdcChange(move.change);
  const percent = Math.abs(move.percent).toFixed(1);
  const lost = amount.startsWith("\u2212");
  return (
    <p className={cn("flex min-w-0 items-baseline gap-2 text-ui leading-5", className)}>
      <span
        className={cn(
          "flex-none font-medium transition-colors duration-300",
          lost
            ? "text-negative"
            : amount.startsWith("+")
              ? "text-positive"
              : "text-muted-foreground",
        )}
      >
        <RollingNumber value={`${amount} (${percent}%)`} />
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        {lost ? "lost" : "made"} {label}
      </span>
    </p>
  );
}
