"use client";

import { cn } from "@/lib/utils";

/**
 * One choice of a few, as a row of pills with the chosen one filled: a chart's period, the look
 * Auni wears. The app's own control wherever a browser would draw a dropdown.
 */
export function ChoicePills<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
  pillClassName,
}: {
  /** What is being chosen, for a screen reader: "Period". */
  readonly label: string;
  readonly options: readonly { readonly value: Value; readonly name: string }[];
  readonly value: Value;
  readonly onChange: (value: Value) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly pillClassName?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex items-center gap-1", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "relative h-8 min-w-11 rounded-full px-3 text-meta font-medium transition-colors duration-200 after:absolute after:inset-x-0 after:-inset-y-1.5 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
            option.value === value
              ? "bg-foreground/[0.07] text-ink"
              : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-ink",
            pillClassName,
          )}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}
