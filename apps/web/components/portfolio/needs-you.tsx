"use client";

import type { SpecialistId, ThreadId } from "@auni/shared";
import { ArrowRight, MessageCircle } from "lucide-react";
import type { ReactNode } from "react";

import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { PlaceLink } from "@/components/places/open-place";
import type { ChatPlace, SpecialistPlace } from "@/components/places/use-places";
import { chatHref, specialistHref } from "@/lib/app-links";
import type { Thread } from "@/lib/data/views";

import { PortfolioSection } from "./portfolio-section";

/**
 * The decisions waiting on the person, and nothing else: one row per place
 * with a card still waiting, saying what it asks. A decision is something to
 * sign, so it is a white card with a hairline, apart from the filled tiles
 * of what the person already holds. The whole row opens the conversation
 * where the card is. Usually empty, and then the section is gone.
 */
export function NeedsYou({
  specialists,
  chats,
  waiting,
  className,
}: {
  readonly specialists: readonly SpecialistPlace[];
  readonly chats: readonly ChatPlace[];
  readonly waiting: ReadonlyMap<string, Thread>;
  readonly className?: string;
}) {
  const rows = [
    ...specialists
      .filter((place) => place.waiting)
      .map(({ specialist }) => (
        <NeedsYouRow
          key={specialist.id}
          href={specialistHref(specialist.id)}
          place={{ specialist: specialist.id }}
          mark={<SpecialistOrb specialist={specialist} size={36} />}
          name={specialist.name}
          ask={waiting.get(specialist.id)?.moneyLine}
        />
      )),
    ...chats
      .filter((chat) => chat.waiting)
      .map(({ thread }) => (
        <NeedsYouRow
          key={thread.id}
          href={chatHref(thread.id)}
          place={{ thread: thread.id }}
          mark={
            <span className="flex size-9 flex-none items-center justify-center rounded-full bg-surface">
              <MessageCircle aria-hidden className="size-4 text-muted-foreground" />
            </span>
          }
          name={thread.title}
          ask={thread.moneyLine}
        />
      )),
  ];
  if (rows.length === 0) return null;
  return (
    <PortfolioSection title="Needs you" className={className}>
      {/* One hairlined list on a phone, like the specialists under it; two cards
          across on a wider screen, splitting the tiles' four columns evenly. */}
      <ul className="overflow-hidden rounded-card border border-foreground/[0.08] sm:grid sm:grid-cols-2 sm:gap-3 sm:overflow-visible sm:rounded-none sm:border-0">
        {rows}
      </ul>
    </PortfolioSection>
  );
}

function NeedsYouRow({
  href,
  place,
  mark,
  name,
  ask,
}: {
  readonly href: string;
  readonly place: { readonly specialist?: SpecialistId; readonly thread?: ThreadId };
  readonly mark: ReactNode;
  readonly name: string;
  readonly ask: string | null | undefined;
}) {
  return (
    // On a phone the rows share one card, parted by a hairline that starts where the words do.
    <li className="relative min-w-0 not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-[62px] not-first:before:h-px not-first:before:bg-foreground/[0.06] sm:not-first:before:hidden">
      <PlaceLink
        href={href}
        {...place}
        className="group flex items-center gap-3 bg-card py-3 pr-3 pl-3.5 transition-colors duration-200 ease-settle hover:bg-foreground/[0.02] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset sm:rounded-card sm:border sm:border-foreground/[0.08]"
      >
        {mark}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-ink">{name}</span>
          <span className="mt-0.5 block truncate text-meta text-muted-foreground">
            {ask ?? "Waiting for your OK"}
          </span>
        </span>
        {/* Looks like a button, but the row is the link: it answers wherever the cursor lands. */}
        <span className="flex h-8 flex-none items-center gap-1 rounded-full bg-foreground pr-3 pl-3.5 text-meta font-semibold text-background transition-[background-color,scale] duration-200 ease-settle group-hover:bg-foreground/85 group-active:scale-[0.97]">
          Review
          <ArrowRight
            aria-hidden
            className="size-3.5 transition-transform duration-300 ease-settle group-hover:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
            strokeWidth={2.4}
          />
        </span>
      </PlaceLink>
    </li>
  );
}
