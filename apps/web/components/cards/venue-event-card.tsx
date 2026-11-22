import type { VenueEventCardWire } from "@auni/shared";

import { AssetLogo } from "@/components/specialist/marks";
import { cn } from "@/lib/utils";

/**
 * Something a venue did to a position, as core leaves it in the chat of the
 * specialist it touched: the venue acting by itself, ringed so it reads as
 * something to look at, or an order Auni placed earlier filling.
 */
export function VenueEventCard({ card }: { readonly card: VenueEventCardWire }) {
  return (
    <div
      className="my-2 flex w-full min-w-0 items-start gap-3 rounded-[18px] border border-foreground/[0.08] bg-card px-3.5 py-3"
      data-outside={card.outside}
      data-testid="venue-event"
    >
      <AssetLogo
        holding={{ logoUrl: card.logoUrl, name: card.title }}
        size={36}
        className={cn("flex-none", card.outside && "ring-2 ring-negative/70 ring-offset-1")}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] leading-5 font-medium text-ink">{card.title}</p>
        <p className="mt-0.5 text-[13.5px] leading-5 break-words text-muted-foreground">
          {card.detail}
        </p>
      </div>
    </div>
  );
}
