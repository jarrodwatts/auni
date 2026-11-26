import type { VenueEventCardWire } from "@auni/shared";

import { formatUsdcChange } from "@/lib/money";
import { dollarsToBaseUnits } from "@/lib/data/usdc";
import { cn } from "@/lib/utils";

import { CardFrame, CardReceipt } from "./card-parts";
import { EventMark } from "./event-mark";

/**
 * Something a venue did to a position, as core leaves it in the thread it touched: a stop or a
 * limit order of Auni's filling, the venue acting by itself, or a market paying out. An event,
 * drawn settled: what happened, why, and what it locked in, as a gain or a loss.
 */
export function VenueEventCard({ card }: { readonly card: VenueEventCardWire }) {
  const pnl = card.pnlUsd ? dollarsToBaseUnits(card.pnlUsd) : null;
  return (
    <div data-outside={card.outside} data-testid="venue-event">
      {/* The venue acting by itself (a liquidation, a trade made outside Auni) is a warning. */}
      <CardFrame label={card.title} phase="confirmed" tone={card.outside ? "warning" : null}>
        <CardReceipt
          mark={<EventMark logoUrl={card.logoUrl} />}
          title={card.title}
          detail={card.detail}
          whole
          amount={
            pnl !== null ? (
              <span className={cn(pnl < 0n ? "text-negative" : "text-positive")}>
                {formatUsdcChange(pnl)}
              </span>
            ) : null
          }
          amountNote={pnl === null ? null : pnl < 0n ? "realized loss" : "realized gain"}
        />
      </CardFrame>
    </div>
  );
}
