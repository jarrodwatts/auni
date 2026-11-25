import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A short word about a thing's state, as a pill. Colour only where it means something:
 *
 *   neutral    most things (Off, Env locked, 3 notes)
 *   waiting    it waits on the owner, and nothing else is amber
 *   positive   a gain, or a done thing the owner was waiting to hear of
 *   negative   a loss, or a failure
 *   ink        a count that wants a look (new activity)
 *
 * Never a dot in front of the word: the word says it.
 */
const TONES = {
  neutral: "bg-foreground/[0.06] text-ink-soft",
  waiting: "bg-waiting-surface text-waiting",
  positive: "bg-positive/[0.1] text-positive",
  negative: "bg-negative/[0.1] text-negative",
  ink: "bg-ink text-paper",
} as const;

type BadgeTone = keyof typeof TONES;

const badgeClass = (tone: BadgeTone = "neutral") =>
  cn(
    "inline-flex h-5 min-w-5 flex-none items-center justify-center gap-1 rounded-full px-2 text-caption font-medium whitespace-nowrap",
    TONES[tone],
  );

function Badge({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & { readonly tone?: BadgeTone }) {
  return <span data-slot="badge" className={cn(badgeClass(tone), className)} {...props} />;
}

export { Badge, badgeClass, type BadgeTone };
