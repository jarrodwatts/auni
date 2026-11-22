"use client";

import type { ArrivalCardWire } from "@auni/shared";
import { ArrowDownLeft } from "lucide-react";
import { createContext, useContext } from "react";

import { movedLine } from "@/components/cards/arrival-card";

const Arrived = createContext<readonly ArrivalCardWire[]>([]);

/** The money that came in for the card under it (lib/arrivals-for-cards.ts). */
export const ArrivedForCard = Arrived.Provider;

/**
 * Money that came in for this card, told in the card's own place, under its picks and above the
 * step it made possible, rather than under the card where the next step would come before it.
 */
export function ArrivedLine() {
  const arrivals = useContext(Arrived);
  if (arrivals.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-foreground/[0.06] pt-4">
      {arrivals.map((arrival) => (
        <p key={arrival.id} className="auni-stagger-in flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 flex-none items-center justify-center rounded-full bg-positive/10 text-positive"
          >
            <ArrowDownLeft className="size-4" strokeWidth={2.4} />
          </span>
          <span className="min-w-0">
            <span className="block text-[14.5px] leading-5 font-medium text-ink">
              {arrival.title}
            </span>
            <span className="block truncate text-[13px] leading-5 text-muted-foreground">
              {movedLine(arrival)}
            </span>
          </span>
        </p>
      ))}
    </div>
  );
}
