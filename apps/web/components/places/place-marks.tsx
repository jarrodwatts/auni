"use client";

import { ChartPie } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProgressRing } from "@/components/motion/progress-ring";
import { glyphMotion } from "@/components/motion/status-mark";
import { swapOf, swapTo } from "@/components/motion/swap";
import { useHandover } from "@/components/motion/use-handover";
import { reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

import type { ChatMark, PlaceAttention } from "./attention";

const ATTENTION_COLOR: Record<NonNullable<PlaceAttention>, string> = {
  waiting: "bg-waiting",
  unread: "bg-primary",
};

/** What a place's dot says, for anyone who can't see it. */
export const ATTENTION_LABEL: Record<NonNullable<PlaceAttention>, string> = {
  waiting: "Waiting on you",
  unread: "New reply",
};

/**
 * Amber means something waits on the person; blue, that Auni answered since
 * they last looked. The ring matches whatever it sits on.
 */
export function WaitingDot({
  attention = "waiting",
  className,
  ring = "ring-sidebar",
}: {
  readonly attention?: NonNullable<PlaceAttention>;
  readonly className?: string;
  readonly ring?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute size-2.5 rounded-full ring-2",
        ATTENTION_COLOR[attention],
        ring,
        className,
      )}
    />
  );
}

/**
 * What trails a chat's title, in one slot: "Your turn" while a card or a
 * question waits on the person, or its money's ring while that moves and
 * until how it went is read. A change hands over, the old mark shrinking
 * away as the new one pops in; a ring's count moves on in place.
 */
export function ChatStatusMark({
  mark,
  className,
}: {
  readonly mark: ChatMark;
  readonly className?: string;
}) {
  const [swap, setSwap] = useState(() => swapOf(mark));
  if (swap.current !== mark) {
    const next = swapTo(swap, mark, swap.current?.kind !== mark?.kind && !reducedMotion());
    // Nothing has nothing to send away, though what comes after it still arrives.
    setSwap({ ...next, leaving: next.leaving.filter(({ value }) => value !== null) });
  }
  const copy = useHandover(swap, setSwap, glyphMotion.leave, glyphMotion.appear);
  // An empty slot takes no room, nor the row's gap before it.
  if (!swap.current && swap.leaving.length === 0) return null;

  const copies = [...swap.leaving, { id: swap.id, value: swap.current }];
  return (
    <span className={cn("relative flex flex-none items-center justify-end", className)}>
      {copies.map(({ id, value }) =>
        value ? (
          <span
            key={id}
            ref={copy(id)}
            aria-hidden={id !== swap.id || undefined}
            className={cn("flex", id !== swap.id && "pointer-events-none absolute right-0")}
          >
            {value.kind === "turn" ? (
              <TurnTag>Your turn</TurnTag>
            ) : (
              <>
                <ProgressRing done={value.done} total={value.total} status={value.status} />
                <span className="sr-only">{MONEY_LABEL[value.status](value)}</span>
              </>
            )}
          </span>
        ) : null,
      )}
    </span>
  );
}

/** What a chat's money ring says, for anyone who can't see it. */
const MONEY_LABEL: Record<
  "now" | "done" | "failed",
  (count: { readonly done: number; readonly total: number }) => string
> = {
  now: ({ done, total }) => `Moving your money, ${done} of ${total} through`,
  done: () => "Your money went through",
  failed: ({ done, total }) => `${done} of ${total} went through`,
};

/** Portfolio's mark: a plain glyph, so the only color in the list is the specialists'. */
export function PortfolioMark({
  size = 18,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <ChartPie
      aria-hidden
      style={{ width: size, height: size }}
      strokeWidth={1.75}
      className={cn("flex-none", className)}
    />
  );
}

const TAG_CLASS_NAME =
  "flex h-5 min-w-5 flex-none items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums";

/** Something waits on the person: "Your turn" on a chat, "1 needs your OK" on a card. */
export function TurnTag({ children }: { readonly children: ReactNode }) {
  return <span className={cn(TAG_CLASS_NAME, "bg-primary/[0.1] text-primary")}>{children}</span>;
}

/** "New": a specialist the agent just made, until it is opened. */
export function NewTag() {
  return <span className={cn(TAG_CLASS_NAME, "bg-primary/[0.09] text-primary")}>New</span>;
}

/** How many places wait on the person: a count points, so it wears the app's blue. */
export function WaitingCount({ count }: { readonly count: number }) {
  return (
    <span
      aria-label={`${count} waiting on you`}
      className={cn(TAG_CLASS_NAME, "bg-primary/[0.1] text-primary")}
    >
      {count}
    </span>
  );
}

/** How many things happened to their money that they haven't looked at: each was done to them, so red. */
export function UnreadCount({ count }: { readonly count: number }) {
  return (
    <span
      aria-label={`${count} unread`}
      className={cn(TAG_CLASS_NAME, "bg-negative text-background")}
    >
      {count}
    </span>
  );
}
