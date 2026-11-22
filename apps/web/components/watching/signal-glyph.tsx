import { cn } from "@/lib/utils";

/** Auni watching: a dot with waves that breathe out while it's on. */
export function SignalGlyph({
  live = true,
  className,
}: {
  readonly live?: boolean;
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={cn("size-3.5 flex-none", live && "auni-watch-signal", className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="8" fill="currentColor" r="1.6" stroke="none" />
      <path d="M5.1 5.5a3.9 3.9 0 0 0 0 5" data-wave="1" />
      <path d="M10.9 5.5a3.9 3.9 0 0 1 0 5" data-wave="1" />
      <path d="M3 3.4a7 7 0 0 0 0 9.2" data-wave="2" />
      <path d="M13 3.4a7 7 0 0 1 0 9.2" data-wave="2" />
    </svg>
  );
}
