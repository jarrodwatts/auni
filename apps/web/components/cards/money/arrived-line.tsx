"use client";

import { createContext, useContext } from "react";

import { movedLine } from "@/components/cards/arrival-card";
import { EventMark } from "@/components/cards/event-mark";
import type { ArrivalsByPlan } from "@/lib/arrivals-for-cards";

const Arrived = createContext<ArrivalsByPlan>(new Map());

/** The money that came in for each plan card under it (lib/arrivals-for-cards.ts). */
export const ArrivedForCard = Arrived.Provider;

/**
 * Money that came in for this card, told in the card's own place, under its picks and above the
 * step it made possible, rather than under the card where the next step would come before it.
 */
export function ArrivedLine({ proposalId }: { readonly proposalId: string }) {
  const arrivals = useContext(Arrived).get(proposalId);
  if (!arrivals?.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      {arrivals.map((arrival) => (
        <p key={arrival.id} className="auni-stagger-in flex min-w-0 items-center gap-3">
          <EventMark coin={arrival.moved[0]?.symbol ?? null} network={arrival.network} />
          <span className="min-w-0">
            <span className="block text-body leading-5 font-medium text-ink">{arrival.title}</span>
            <span className="block truncate text-meta leading-5 text-muted-foreground">
              {movedLine(arrival)}
            </span>
          </span>
        </p>
      ))}
    </div>
  );
}
