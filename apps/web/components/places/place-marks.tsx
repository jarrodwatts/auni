"use client";

import { ChartPie } from "lucide-react";
import type { ReactNode } from "react";

import { Change } from "@/components/brand/marks";
import { ProgressRing } from "@/components/motion/progress-ring";
import { changePercent, formatUsdcBalance } from "@/lib/money";
import { cn } from "@/lib/utils";

import type { MoneyProgress } from "./attention";
import type { TakeValue } from "./use-takes";

/** A thread's money ring, while it moves and until how it went is read. */
export function MoneyRing({ money }: { readonly money: MoneyProgress }) {
  return (
    <span className="flex flex-none items-center">
      <ProgressRing done={money.done} total={money.total} status={money.status} />
      <span className="sr-only">{MONEY_LABEL[money.status](money)}</span>
    </span>
  );
}

/** What a thread's money ring says, for anyone who can't see it. */
const MONEY_LABEL: Record<
  MoneyProgress["status"],
  (count: { readonly done: number; readonly total: number }) => string
> = {
  now: ({ done, total }) =>
    total === 1 ? "Moving your money" : `Moving your money, ${done} of ${total} done`,
  done: () => "Your money went through",
  failed: ({ done, total }) =>
    done === 0 ? "Move didn't go through" : `${done} of ${total} moves went through`,
};

/**
 * A take's worth and its day, side by side: "$2,932.30 ▲1.5% today". The word says which change
 * it is, since Money shows each take's change since entry. The change is green or red only as a
 * number, and absent when a holding's day isn't known.
 */
export function TakeFigures({
  take,
  className,
}: {
  readonly take: TakeValue;
  readonly className?: string;
}) {
  return (
    <span className={cn("flex flex-none items-baseline gap-2 tabular-nums", className)}>
      <span className="font-medium text-ink">{formatUsdcBalance(take.value)}</span>
      {take.change === null ? null : (
        <span className="flex items-baseline gap-1">
          <Change pct={changePercent(take.change, take.value)} period="today" />
          <span aria-hidden className="text-muted-foreground">
            today
          </span>
        </span>
      )}
    </span>
  );
}

/** Money's mark: a plain glyph. */
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
  "flex h-5 min-w-5 flex-none items-center justify-center rounded-full px-1.5 text-caption font-semibold tabular-nums";

/** Something waits on the person: "1 needs your OK" on a card. */
export function TurnTag({ children }: { readonly children: ReactNode }) {
  return <span className={cn(TAG_CLASS_NAME, "bg-waiting-surface text-waiting")}>{children}</span>;
}

/** How many things wait on the person: amber, which means that and only that. */
export function WaitingCount({
  count,
  className,
}: {
  readonly count: number;
  readonly className?: string;
}) {
  return (
    <span
      aria-label={`${count} waiting on you`}
      className={cn(TAG_CLASS_NAME, "bg-waiting-surface text-waiting", className)}
    >
      {count}
    </span>
  );
}
