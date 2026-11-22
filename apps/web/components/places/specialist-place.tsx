"use client";

import type { SpecialistId } from "@auni/shared";
import { useEffect } from "react";

import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { Change } from "@/components/specialist/marks";
import { SpecialistMenu } from "@/components/specialist/manage/specialist-menu";
import { showsMoney, useSpecialist } from "@/components/specialist/use-specialists";
import { Skeleton } from "@/components/ui/skeleton";
import type { Specialist } from "@/lib/data/views";
import { changePercent, formatUsdcBalance } from "@/lib/money";

import { MissingPlace } from "./chat-place";
import { PlaceConversation, useSpecialistThread } from "./place-conversation";
import { PlaceHeader } from "./place-header";
import { markSpecialistSeen } from "./stored-state";

/** What a specialist's reply box invites, before and once the specialist is known. */
function specialistPlaceholder(specialist: Pick<Specialist, "name"> | undefined) {
  return specialist ? `Message ${specialist.name}` : "Message your specialist";
}

/**
 * A specialist's page: its one conversation down the middle, from the card
 * that started it, with everything about it (purpose, money, watches, notes,
 * record) in the pane beside it.
 */
export function SpecialistPlace({ specialistId }: { readonly specialistId: SpecialistId }) {
  const { specialist, loading } = useSpecialist(specialistId);
  const threadId = useSpecialistThread(specialistId);
  const hasMoney = showsMoney(specialist);

  // Opening a specialist the agent just made is what clears its "New".
  useEffect(() => markSpecialistSeen(specialistId), [specialistId]);

  if (!specialist && !loading) return <MissingPlace what="specialist" />;

  const value = specialist ? BigInt(specialist.value.baseUnits) : null;
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      {specialist ? <title>{`${specialist.name} | auni`}</title> : null}
      <PlaceHeader
        pane={specialist !== undefined}
        icon={
          specialist ? (
            <SpecialistOrb specialist={specialist} size={22} />
          ) : (
            <Skeleton className="size-[22px] rounded-full" />
          )
        }
        title={
          specialist ? (
            <>
              {/* A phone header has room for the short name beside the value. */}
              <span className="sm:hidden">{specialist.name}</span>
              <span className="hidden sm:inline">{specialist.purpose}</span>
            </>
          ) : (
            <Skeleton className="h-4 w-48 rounded-md" />
          )
        }
        actions={specialist ? <SpecialistMenu specialist={specialist} /> : null}
        money={
          specialist && value !== null && hasMoney ? (
            <>
              <span className="font-semibold text-ink">{formatUsdcBalance(value)}</span>
              {/* A phone header keeps room for the name; today's move is one tap away. */}
              <Change
                pct={changePercent(BigInt(specialist.todayChangeBaseUnits), value)}
                period="today"
                className="font-medium max-sm:hidden"
              />
            </>
          ) : null
        }
      />
      <PlaceConversation threadId={threadId} placeholder={specialistPlaceholder(specialist)} />
    </section>
  );
}
