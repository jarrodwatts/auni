"use client";

import type { ArrivalCardWire } from "@auni/shared";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { cn } from "@/lib/utils";

/**
 * Money that moved without Auni, as core leaves it in their chat: what came
 * in, or what left that Auni didn't send, calmly, with where to act if it
 * wasn't them.
 */
export function ArrivalCard({ card }: { readonly card: ArrivalCardWire }) {
  const { settingsHref } = useAppDialogs();
  const out = card.direction === "out";
  const Arrow = out ? ArrowUpRight : ArrowDownLeft;
  return (
    <div
      className="my-2 flex w-full min-w-0 items-start gap-3 rounded-card border border-foreground/[0.08] bg-card px-3.5 py-3"
      data-direction={card.direction}
      data-testid="arrival"
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 flex-none items-center justify-center rounded-full",
          out ? "bg-surface text-ink-soft" : "bg-positive/10 text-positive",
        )}
      >
        <Arrow className="size-4" strokeWidth={2.4} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body leading-5 font-medium text-ink">{card.title}</p>
        <p className="mt-0.5 text-ui leading-5 break-words text-muted-foreground">
          {movedLine(card)}
        </p>
        {out ? (
          <p className="mt-1.5 text-meta leading-[1.45] text-muted-foreground">
            If this was you, there&apos;s nothing to do. If it wasn&apos;t, withdraw what&apos;s
            left to an address you trust.
          </p>
        ) : null}
      </div>
      {out ? (
        <Link
          href={settingsHref("wallet")}
          scroll={false}
          className="flex h-9 flex-none items-center rounded-full bg-foreground px-4 text-ui font-semibold text-background"
        >
          Wallet
        </Link>
      ) : null}
    </div>
  );
}

/** "0.081 ETH on Base", or "40 USDC to 0x1a2b3c…9f8e on Base". */
export function movedLine(card: Pick<ArrivalCardWire, "moved" | "network">): string {
  const items = card.moved.map(
    ({ amount, symbol, to, network }) =>
      `${amount} ${symbol}${network ? ` on ${network}` : ""}${to ? ` to ${to}` : ""}`,
  );
  return (
    items.join(" and ") + (card.moved.some(({ network }) => network) ? "" : ` on ${card.network}`)
  );
}
