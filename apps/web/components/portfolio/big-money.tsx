import { cn } from "@/lib/utils";

import { RollingNumber } from "./rolling-number";

/** The balance at its largest, in one color: formatting alone keeps it calm. Its digits roll as it changes. */
export function BigMoney({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string;
}) {
  return (
    <p className={cn("text-hero-money text-foreground", className)}>
      <RollingNumber value={value} />
    </p>
  );
}
