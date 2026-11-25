import { cn } from "@/lib/utils";

const DIGITS = [..."0123456789"];

/**
 * Text whose digits roll to their new value: each digit is a column of 0 to 9
 * slid into place, so the width never changes and nothing reflows. The rest
 * (the $, the commas, the point) stands still. Reduced motion swaps at once.
 */
export function RollingNumber({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string;
}) {
  const chars = [...value];
  return (
    <span className={cn("inline-flex leading-[1.1] whitespace-pre tabular-nums", className)}>
      <span className="sr-only">{value}</span>
      {chars.map((char, index) => {
        // Keyed from the right, so the cents keep their columns when a thousands digit arrives.
        const place = chars.length - index;
        const digit = DIGITS.indexOf(char);
        return digit < 0 ? (
          <span key={`${place}${char}`} aria-hidden>
            {char}
          </span>
        ) : (
          <Digit key={place} digit={digit} />
        );
      })}
    </span>
  );
}

function Digit({ digit }: { readonly digit: number }) {
  return (
    <span aria-hidden className="relative inline-block h-[1.1em] overflow-hidden">
      <span className="invisible">0</span>
      <span
        className="absolute inset-x-0 top-0 flex flex-col transition-transform duration-[420ms] ease-settle motion-reduce:transition-none"
        style={{ transform: `translateY(${-digit * 1.1}em)` }}
      >
        {DIGITS.map((face) => (
          <span key={face} className="h-[1.1em]">
            {face}
          </span>
        ))}
      </span>
    </span>
  );
}
