import { formatUsdcChange } from "@/lib/money";
import { cn } from "@/lib/utils";

import { RollingNumber } from "./rolling-number";

/** What the money made over the chart's period (see madeChange), and over what: "−$0.94 (5.2%) Past week". */
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
  return (
    <p className={cn("flex min-w-0 items-baseline gap-2 text-ui leading-5", className)}>
      <span
        className={cn(
          "flex-none font-medium transition-colors duration-300",
          amount.startsWith("+")
            ? "text-positive"
            : amount.startsWith("$")
              ? "text-muted-foreground"
              : "text-negative",
        )}
      >
        <RollingNumber value={`${amount} (${percent}%)`} />
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
    </p>
  );
}
