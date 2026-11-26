import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A short word about a thing's state, as a pill. Colour only where it means something, and each
 * tone is a pair tokens.test.ts holds to AA:
 *
 *   neutral    most things, healthy ones included (Off, Connected, 16 ok, 3 notes)
 *   waiting    it waits on the owner (to fix, to allow), and nothing else is amber
 *   gain       money gained, or money the owner was waiting on that arrived
 *   loss       money lost, or something that failed
 *   ink        a count that wants a look (new activity)
 *
 * Green is money's, so a thing that merely works is neutral; a broken thing the owner must fix
 * waits on them. Never a dot in front of the word: the word says it. Never blue: blue is Auni's.
 */
const TONES = {
  neutral: "bg-muted text-ink-soft",
  waiting: "bg-waiting-surface text-waiting",
  gain: "bg-muted text-positive",
  loss: "bg-muted text-negative",
  ink: "bg-ink text-paper",
} as const;

type BadgeTone = keyof typeof TONES;

const badgeClass = (tone: BadgeTone = "neutral") =>
  cn(
    "inline-flex h-5 min-w-5 flex-none items-center justify-center gap-1 rounded-full px-2 text-caption font-medium whitespace-nowrap tabular-nums",
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
