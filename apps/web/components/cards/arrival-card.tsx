"use client";

import type { ArrivalCardWire } from "@auni/shared";
import Link from "next/link";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { buttonVariants } from "@/components/ui/button";

import { CardFrame, CardReceipt } from "./card-parts";
import { EventMark } from "./event-mark";

/**
 * Money that moved without Auni, as core leaves it in their chat: what came in, or what left
 * that Auni didn't send, calmly, with where to act if it wasn't them. An event, so it is drawn
 * settled: the coin, what happened, and on which network.
 */
export function ArrivalCard({ card }: { readonly card: ArrivalCardWire }) {
  const { settingsHref } = useAppDialogs();
  const out = card.direction === "out";
  return (
    <div data-direction={card.direction} data-testid="arrival">
      <CardFrame label={card.title} phase="confirmed">
        <CardReceipt
          mark={<EventMark coin={card.moved[0]?.symbol ?? null} network={card.network} />}
          title={card.title}
          detail={movedLine(card)}
          whole
          trailing={
            out ? (
              <div className="flex flex-col items-start gap-2.5">
                <p className="text-meta leading-[1.45] text-pretty text-muted-foreground">
                  If this was you, there&apos;s nothing to do. If it wasn&apos;t, withdraw
                  what&apos;s left to an address you trust.
                </p>
                <Link
                  href={settingsHref("wallet")}
                  scroll={false}
                  className={buttonVariants({ size: "sm", variant: "secondary" })}
                >
                  Open your wallet
                </Link>
              </div>
            ) : null
          }
        />
      </CardFrame>
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
