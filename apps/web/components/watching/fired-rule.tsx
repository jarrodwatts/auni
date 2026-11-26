import type { MessageFire } from "@/lib/conversation";

import { SignalGlyph } from "./signal-glyph";
import { spokeAt } from "./watch-time";

/**
 * Where an answer watches started begins: a quiet rule saying when, and which
 * of the watches the person saw set up spoke. It stands in for the day's rule.
 */
export function FiredRule({
  fires,
  createdAt,
}: {
  readonly fires: readonly MessageFire[];
  readonly createdAt: string | undefined;
}) {
  const watches = fires.map(({ watch }) => watch).join(", ");
  return (
    <div
      role="separator"
      aria-label={`${fires.length > 1 ? "Watches" : "A watch"} spoke up: ${watches}`}
      className="mb-7 flex items-center gap-2.5 text-meta font-medium text-muted-foreground"
    >
      <span aria-hidden className="h-px min-w-6 flex-1 bg-foreground/[0.07]" />
      <SignalGlyph live={false} className="text-primary" />
      {createdAt ? <span className="flex-none text-ink">{spokeAt(createdAt, true)}</span> : null}
      <span className="min-w-0 truncate">{watches}</span>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-foreground/[0.07]" />
    </div>
  );
}
