"use client";

import type { ActivityItemWire } from "@auni/shared";

import { amountText, TONE_CLASS_NAME } from "@/components/activity/activity-groups";
import { ItemMark } from "@/components/activity/activity-receipt";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ChartMoment } from "./dawn-moments";
import type { ChartMove } from "./money-groups";

/**
 * The owner's moves as beads on the Money line: money in or out a quiet grey, written on the
 * chart where it's among the largest, so a deposit never reads as a gain; a trade in ink. Each
 * opens a small card naming it, with its receipt a tap away.
 */
export function moveMoments(
  moves: readonly ChartMove[],
  onOpen: (item: ActivityItemWire) => void,
): ChartMoment[] {
  return moves.map(({ item, at, noted }) => {
    const amount = item.amount ? amountText(item.amount) : null;
    return {
      key: item.id,
      at,
      tone: item.category === "transfer" ? "neutral" : "ink",
      label: [item.title, amount, item.subtitle].filter(Boolean).join(", "),
      ...(noted && amount ? { note: { title: item.title, line: amount, lineTone: "faint" } } : {}),
      detail: <MoveCard item={item} amount={amount} onOpen={() => onOpen(item)} />,
    } satisfies ChartMoment;
  });
}

function MoveCard({
  item,
  amount,
  onOpen,
}: {
  readonly item: ActivityItemWire;
  readonly amount: string | null;
  readonly onOpen: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <ItemMark item={item} size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-ink">{item.title}</p>
          <p className="truncate text-meta text-muted-foreground">{item.subtitle}</p>
        </div>
        {amount && item.amount ? (
          <span
            className={cn("text-ui font-medium tabular-nums", TONE_CLASS_NAME[item.amount.tone])}
          >
            {amount}
          </span>
        ) : null}
      </div>
      <Button variant="secondary" size="sm" className="self-start" onClick={onOpen}>
        View receipt
      </Button>
    </div>
  );
}
