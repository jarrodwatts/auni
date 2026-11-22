"use client";

import { ChoicePills } from "@/components/ui/choice-pills";
import { cn } from "@/lib/utils";

import type { ChartRange } from "./chart-ranges";

export function RangePicker({
  ranges,
  value,
  onChange,
  className,
}: {
  readonly ranges: readonly ChartRange[];
  readonly value: ChartRange;
  readonly onChange: (range: ChartRange) => void;
  readonly className?: string;
}) {
  if (ranges.length < 2) return null;
  // On a phone the periods share a full row; each hits 44px tall either way.
  return (
    <ChoicePills
      label="Period"
      options={ranges.map((range) => ({ value: range, name: range }))}
      value={value}
      onChange={onChange}
      className={cn("max-sm:w-full", className)}
      pillClassName="max-sm:h-9 max-sm:flex-1 max-sm:after:-inset-y-1"
    />
  );
}
